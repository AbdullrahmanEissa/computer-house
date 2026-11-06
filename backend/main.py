"""
FastAPI entrypoint.

Run:  uvicorn main:app --host 0.0.0.0 --port 8000
"""
import logging
import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from uuid import UUID

import sentry_sdk
from fastapi import FastAPI, Header, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field, field_validator, model_validator
from sentry_sdk.integrations.celery import CeleryIntegration
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration
from sentry_sdk.scrubber import DEFAULT_DENYLIST, EventScrubber
from supabase import Client

from config import settings
from database import get_supabase
from tasks import forward_order_to_dropshipper, send_whatsapp_confirmation

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("orders.api")

# ---------------------------------------------------------------------------
# Sentry: errors + APM traces (init BEFORE the FastAPI app is created)
# ---------------------------------------------------------------------------
sentry_sdk.init(
    dsn=settings.sentry_dsn or None,  # no DSN (local dev) -> Sentry stays disabled
    environment=settings.environment,
    release=settings.release,
    traces_sample_rate=settings.sentry_traces_sample_rate,
    send_default_pii=False,
    # Customer data must not end up in Sentry events (request bodies are captured on errors).
    event_scrubber=EventScrubber(
        denylist=DEFAULT_DENYLIST + ["contact_phone", "phone", "shipping_address", "customer_name"]
    ),
    integrations=[
        StarletteIntegration(transaction_style="endpoint"),
        FastApiIntegration(transaction_style="endpoint"),
        CeleryIntegration(),  # links API traces to the Celery tasks they enqueue
    ],
)

app = FastAPI(title="Store API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Idempotency-Key"],
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
class OrderItemIn(BaseModel):
    product_id: UUID | None = None  # change to int if your primary keys are bigint
    bundle_id: UUID | None = None
    quantity: int = Field(gt=0, le=100)
    unit_price: Decimal = Field(ge=0, max_digits=10, decimal_places=2)

    @model_validator(mode="after")
    def _exactly_one_target(self) -> "OrderItemIn":
        if (self.product_id is None) == (self.bundle_id is None):
            raise ValueError("Provide exactly one of product_id or bundle_id")
        return self


class OrderIn(BaseModel):
    customer_id: UUID
    customer_name: str = Field(min_length=2, max_length=120)
    contact_phone: str
    shipping_address: str | dict[str, Any]  # text or jsonb, depending on your column type
    items: list[OrderItemIn] = Field(min_length=1, max_length=50)
    idempotency_key: str | None = Field(default=None, min_length=16, max_length=128)  # header wins

    @field_validator("contact_phone")
    @classmethod
    def _clean_phone(cls, v: str) -> str:
        v = re.sub(r"[\s\-()]", "", v)
        if not re.fullmatch(r"\+?\d{8,15}", v):
            raise ValueError("contact_phone must contain 8-15 digits (optional leading +)")
        return v


class OrderCreated(BaseModel):
    order_id: str
    status: str
    idempotent_replay: bool = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _is_idempotency_conflict(exc: APIError) -> bool:
    """Postgres unique_violation (23505) on the idempotency_key column."""
    text = f"{getattr(exc, 'details', '')} {getattr(exc, 'message', '')}"
    return getattr(exc, "code", None) == "23505" and "idempotency_key" in text


def _replay_existing_order(sb: Client, key: str, customer_id: UUID, response: Response) -> OrderCreated:
    rows = (
        sb.table("orders")
        .select("id,customer_id,status")
        .eq("idempotency_key", key)
        .limit(1)
        .execute()
        .data
    )
    if not rows:  # constraint fired but the row isn't visible: extremely unlikely, ask client to retry
        raise HTTPException(status.HTTP_409_CONFLICT, "Order is being created, please retry")
    existing = rows[0]
    if str(existing["customer_id"]) != str(customer_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "Idempotency-Key was already used for a different order")
    response.status_code = status.HTTP_200_OK  # not 201: nothing new was created
    return OrderCreated(order_id=str(existing["id"]), status=existing["status"], idempotent_replay=True)


def _rollback_order(sb: Client, order_id: str) -> None:
    """supabase-py has no multi-statement transactions, so undo the order by hand."""
    try:
        sb.table("orders").delete().eq("id", order_id).execute()
    except Exception:
        logger.exception("ROLLBACK FAILED: order %s was left without items", order_id)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# `def`, not `async def`, on purpose: supabase-py is synchronous. FastAPI runs plain `def`
# handlers in a threadpool, so DB calls don't block the event loop.
@app.post("/api/orders", response_model=OrderCreated, status_code=status.HTTP_201_CREATED)
def create_order(
    payload: OrderIn,
    response: Response,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key", min_length=16, max_length=128),
) -> OrderCreated:
    key = idempotency_key or payload.idempotency_key
    if not key:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Idempotency-Key header (or idempotency_key field) is required")

    # Never trust a client-sent total. TODO: also look unit_price up from your products/bundles
    # tables instead of accepting it from the browser.
    total = sum((i.unit_price * i.quantity for i in payload.items), Decimal("0"))
    total = total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    sb = get_supabase()

    # 1) Insert the order. A repeated Idempotency-Key trips the UNIQUE constraint.
    try:
        order = (
            sb.table("orders")
            .insert({
                "customer_id": str(payload.customer_id),
                "idempotency_key": key,
                "total_amount": str(total),
                "shipping_address": payload.shipping_address,
                "contact_phone": payload.contact_phone,
                "status": "pending",
            })
            .execute()
            .data[0]
        )
    except APIError as exc:
        if _is_idempotency_conflict(exc):
            return _replay_existing_order(sb, key, payload.customer_id, response)
        raise  # anything else is a real error -> 500 + Sentry

    order_id = str(order["id"])

    # 2) Insert the items (undo the order if this fails).
    items = [
        {
            "product_id": str(i.product_id) if i.product_id else None,
            "bundle_id": str(i.bundle_id) if i.bundle_id else None,
            "quantity": i.quantity,
            "unit_price": str(i.unit_price),
        }
        for i in payload.items
    ]
    try:
        sb.table("order_items").insert([{"order_id": order_id, **item} for item in items]).execute()
    except Exception:
        _rollback_order(sb, order_id)
        raise

    # 3) Hand off to Celery and return immediately. The order is already safe in the DB, so a
    #    broker hiccup must not fail the customer's checkout.
    dropship_payload = {
        "order_id": order_id,
        "customer_name": payload.customer_name,
        "phone": payload.contact_phone,
        "shipping_address": payload.shipping_address,
        "total_amount": str(total),
        "items": items,
    }
    publish_retry = {"max_retries": 3, "interval_start": 0, "interval_step": 0.2, "interval_max": 1}
    for task, args in (
        (send_whatsapp_confirmation, [order_id, payload.contact_phone, payload.customer_name]),
        (forward_order_to_dropshipper, [order_id, dropship_payload]),
    ):
        try:
            task.apply_async(args=args, retry=True, retry_policy=publish_retry)
        except Exception:
            # Logged at ERROR, which Sentry's logging integration reports automatically.
            logger.exception("Could not enqueue %s for order %s", task.name, order_id)

    logger.info("Order %s created (%d items)", order_id, len(items))
    return OrderCreated(order_id=order_id, status=order["status"])
