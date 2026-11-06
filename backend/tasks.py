"""
Celery application + background tasks.

Start a worker (from the project folder):
    celery -A tasks.celery_app worker -Q notifications,dropship -l info -c 4
"""
import logging
import random
import time
import uuid
from contextlib import contextmanager
from functools import lru_cache
from typing import Any, Iterator

import httpx
import redis
import sentry_sdk
from celery import Celery, Task, signals
from sentry_sdk.integrations.celery import CeleryIntegration

from config import settings
from database import get_supabase

logger = logging.getLogger("orders.tasks")

# These must be valid values for your orders.status column / enum.
ORDER_STATUS_FORWARDED = "forwarded"
ORDER_STATUS_DROPSHIP_FAILED = "dropship_failed"

DONE_MARKER_TTL = 7 * 24 * 3600  # how long we remember "this order was already handled"
HTTP_TIMEOUT = httpx.Timeout(10.0, connect=3.0)

# ---------------------------------------------------------------------------
# Celery app
# ---------------------------------------------------------------------------
celery_app = Celery("shop", broker=settings.redis_url)
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_ignore_result=True,  # we never read task results, so don't store them in Redis
    # Ack AFTER the task finishes so a crashed worker's tasks get redelivered.
    # Consequence: a task can run twice, which is why both tasks below are idempotent.
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_soft_time_limit=45,
    task_time_limit=60,
    broker_connection_retry_on_startup=True,
    # Redis re-delivers un-acked tasks after this many seconds. Keep it well ABOVE the
    # longest retry countdown (600s), otherwise delayed retries get delivered twice.
    broker_transport_options={"visibility_timeout": 3600},
    # Separate queues: a Taager outage can't starve WhatsApp messages (and vice versa).
    task_routes={
        "orders.send_whatsapp_confirmation": {"queue": "notifications"},
        "orders.forward_order_to_dropshipper": {"queue": "dropship"},
    },
)


# ---------------------------------------------------------------------------
# Sentry for the worker process (the API process is initialised in main.py)
# ---------------------------------------------------------------------------
def _scrub_celery_event(event: dict, hint: dict) -> dict:
    """Task args contain phone numbers / addresses. Keep them out of Sentry."""
    job = event.get("extra", {}).get("celery-job")
    if job:
        job["args"] = job["kwargs"] = "[Filtered]"
    return event  # the order_id is still attached as a tag inside each task


@signals.celeryd_init.connect
def _init_sentry_in_worker(**_: Any) -> None:
    sentry_sdk.init(
        dsn=settings.sentry_dsn or None,
        environment=settings.environment,
        release=settings.release,
        traces_sample_rate=settings.sentry_traces_sample_rate,
        send_default_pii=False,
        integrations=[CeleryIntegration()],
        before_send=_scrub_celery_event,
    )


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------
class TransientIntegrationError(Exception):
    """Temporary problem (timeout, 5xx, 429). Retry with backoff; counts toward the breaker."""


class PermanentIntegrationError(Exception):
    """The third party rejected the request (4xx). Retrying won't help."""


class CircuitOpenError(Exception):
    """The breaker is open: we refuse to call the API right now."""

    def __init__(self, name: str, retry_after: int) -> None:
        super().__init__(f"Circuit '{name}' is open; try again in ~{retry_after}s")
        self.retry_after = retry_after


# ---------------------------------------------------------------------------
# Circuit breaker (state in Redis, shared by ALL worker processes)
# ---------------------------------------------------------------------------
class RedisCircuitBreaker:
    """
    CLOSED     normal; failures are counted inside a rolling window.
    OPEN       too many failures -> calls are rejected instantly (fail fast).
    HALF-OPEN  after `recovery_timeout`, exactly ONE probe call is let through:
               success closes the circuit, failure re-opens it.
    """

    def __init__(
        self,
        name: str,
        redis_client: redis.Redis,
        *,
        failure_threshold: int = 5,
        failure_window: int = 60,
        recovery_timeout: int = 60,
        probe_ttl: int = 30,
    ) -> None:
        self.name = name
        self.r = redis_client
        self.failure_threshold = failure_threshold
        self.failure_window = failure_window
        self.recovery_timeout = recovery_timeout
        self.probe_ttl = probe_ttl
        prefix = f"circuit:{name}"
        self._failures = f"{prefix}:failures"  # counter, expires after failure_window
        self._open = f"{prefix}:open"          # exists (with TTL) while OPEN
        self._tripped = f"{prefix}:tripped"    # exists from OPEN until a probe succeeds
        self._probe = f"{prefix}:probe"        # held by the single HALF-OPEN probe call

    def before_call(self) -> None:
        remaining = self.r.ttl(self._open)
        if remaining >= 0:  # OPEN
            raise CircuitOpenError(self.name, max(remaining, 1))
        if self.r.exists(self._tripped):  # HALF-OPEN: only the first caller becomes the probe
            if not self.r.set(self._probe, "1", nx=True, ex=self.probe_ttl):
                raise CircuitOpenError(self.name, max(self.r.ttl(self._probe), 1))

    def record_success(self) -> None:
        self.r.delete(self._failures, self._open, self._tripped, self._probe)

    def record_failure(self) -> None:
        if self.r.exists(self._tripped):  # the HALF-OPEN probe failed -> open again
            self._trip(reopened=True)
            return
        count = self.r.incr(self._failures)
        if self.r.ttl(self._failures) < 0:  # first failure of a window (or TTL lost)
            self.r.expire(self._failures, self.failure_window)
        if count >= self.failure_threshold:
            self._trip(reopened=False)

    def _trip(self, *, reopened: bool) -> None:
        pipe = self.r.pipeline()
        pipe.set(self._open, "1", ex=self.recovery_timeout)
        pipe.set(self._tripped, "1")
        pipe.delete(self._failures, self._probe)
        pipe.execute()
        log = logger.warning if reopened else logger.error  # ERROR logs show up in Sentry
        log("Circuit '%s' %s; failing fast for %ss", self.name,
            "RE-OPENED (probe failed)" if reopened else "OPENED", self.recovery_timeout)

    @contextmanager
    def guard(self) -> Iterator[None]:
        """`with breaker.guard(): call_api()` - checks the breaker, records the outcome."""
        self.before_call()
        try:
            yield
        except TransientIntegrationError:
            self.record_failure()
            raise
        except PermanentIntegrationError:
            self.record_success()  # the API answered (with a 4xx), so it is up
            raise
        else:
            self.record_success()


@lru_cache(maxsize=1)
def get_redis() -> redis.Redis:
    return redis.Redis.from_url(settings.redis_url, decode_responses=True)


@lru_cache(maxsize=1)
def get_taager_breaker() -> RedisCircuitBreaker:
    return RedisCircuitBreaker("taager", get_redis(), failure_threshold=5,
                               failure_window=60, recovery_timeout=60)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _mask_phone(phone: str) -> str:
    return f"{'*' * max(len(phone) - 4, 0)}{phone[-4:]}"


def _to_international(phone: str) -> str:
    digits = phone.lstrip("+")
    if digits.startswith("00"):
        return digits[2:]
    if digits.startswith("0"):
        return settings.default_country_code + digits[1:]
    return digits


def _check_response(resp: httpx.Response, service: str) -> None:
    code = resp.status_code
    if code in (408, 425, 429) or code >= 500:
        raise TransientIntegrationError(f"{service} returned HTTP {code}")
    if code >= 400:
        raise PermanentIntegrationError(f"{service} rejected the request: HTTP {code}")


def _set_order_status(order_id: str, new_status: str) -> None:
    """Best-effort: a failed status update must never trigger a re-send to a third party."""
    try:
        get_supabase().table("orders").update({"status": new_status}).eq("id", order_id).execute()
    except Exception:
        logger.exception("Could not set order %s to status '%s'", order_id, new_status)


# ---------------------------------------------------------------------------
# Third-party calls (mocked unless MOCK_INTEGRATIONS=false)
# ---------------------------------------------------------------------------
def _send_whatsapp(phone: str, text: str) -> str:
    """Returns the provider's message id. Adjust the request to your provider (Ultramsg shown)."""
    if settings.mock_integrations:
        time.sleep(0.1)
        if random.random() < settings.mock_failure_rate:
            raise TransientIntegrationError("WhatsApp mock: simulated 503")
        logger.info("[MOCK] WhatsApp message to %s (%d chars)", _mask_phone(phone), len(text))
        return f"mock-{uuid.uuid4().hex[:12]}"
    try:
        resp = httpx.post(
            f"{settings.whatsapp_api_url}/messages/chat",
            data={"token": settings.whatsapp_token, "to": _to_international(phone), "body": text},
            timeout=HTTP_TIMEOUT,
        )
    except httpx.HTTPError as exc:  # timeouts, connection resets, DNS...
        raise TransientIntegrationError(f"WhatsApp transport error: {exc!r}") from exc
    _check_response(resp, "WhatsApp")
    return str(resp.json().get("id", ""))


def _call_taager(order_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    if settings.mock_integrations:
        time.sleep(0.2)
        if random.random() < settings.mock_failure_rate:
            raise TransientIntegrationError("Taager mock: simulated 503")
        return {"taager_order_id": f"TGR-{uuid.uuid4().hex[:10].upper()}", "status": "accepted"}
    try:
        resp = httpx.post(
            f"{settings.taager_api_url}/orders",
            json=payload,
            headers={
                "Authorization": f"Bearer {settings.taager_api_key}",
                # If Taager supports idempotency keys, a redelivered task can't create a duplicate.
                "Idempotency-Key": f"order-{order_id}",
            },
            timeout=HTTP_TIMEOUT,
        )
    except httpx.HTTPError as exc:
        raise TransientIntegrationError(f"Taager transport error: {exc!r}") from exc
    _check_response(resp, "Taager")
    return resp.json()


# ---------------------------------------------------------------------------
# Task 1: WhatsApp confirmation  (exponential backoff)
# ---------------------------------------------------------------------------
@celery_app.task(
    bind=True,
    name="orders.send_whatsapp_confirmation",
    autoretry_for=(TransientIntegrationError,),
    retry_backoff=2,        # waits ~2s, 4s, 8s, 16s, ...
    retry_backoff_max=300,  # ... capped at 5 minutes
    retry_jitter=True,      # randomise each wait so retries don't arrive in waves
    max_retries=6,
)
def send_whatsapp_confirmation(self: Task, order_id: str, phone: str, customer_name: str) -> dict[str, Any]:
    sentry_sdk.set_tag("order_id", order_id)
    r = get_redis()
    done_key = f"whatsapp:done:{order_id}"
    if r.exists(done_key):  # idempotency: never message the customer twice
        return {"order_id": order_id, "status": "already_sent"}

    # English: "Hi {name}! We received your order #{ref}. We'll contact you shortly to confirm shipping."
    text = (
        f"أهلاً {customer_name}! 👋\n"
        f"تم استلام طلبك رقم #{order_id[:8].upper()}، وسنتواصل معك قريبًا لتأكيد الشحن.\n"
        "شكرًا لتسوقك معنا 🙏"
    )
    try:
        message_id = _send_whatsapp(phone, text)
    except PermanentIntegrationError as exc:
        # Bad number etc. This is a data problem, not an outage: log it and stop retrying.
        logger.warning("WhatsApp rejected order %s (%s): %s", order_id, _mask_phone(phone), exc)
        return {"order_id": order_id, "status": "rejected"}

    r.set(done_key, message_id or "1", ex=DONE_MARKER_TTL)
    logger.info("WhatsApp confirmation sent for order %s (attempt %d)", order_id, self.request.retries + 1)
    return {"order_id": order_id, "status": "sent", "message_id": message_id}


# ---------------------------------------------------------------------------
# Task 2: forward to Taager  (exponential backoff + circuit breaker)
# ---------------------------------------------------------------------------
class DropshipTask(Task):
    def on_failure(self, exc, task_id, args, kwargs, einfo):  # runs once, after retries are exhausted
        order_id = args[0] if args else kwargs.get("order_id")
        if order_id:
            _set_order_status(order_id, ORDER_STATUS_DROPSHIP_FAILED)  # so a human can see/replay it


@celery_app.task(
    bind=True,
    base=DropshipTask,
    name="orders.forward_order_to_dropshipper",
    autoretry_for=(TransientIntegrationError,),
    retry_backoff=5,         # waits ~5s, 10s, 20s, 40s, ...
    retry_backoff_max=600,   # ... capped at 10 minutes
    retry_jitter=True,
    max_retries=8,
)
def forward_order_to_dropshipper(self: Task, order_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    sentry_sdk.set_tag("order_id", order_id)
    r = get_redis()
    done_key = f"dropship:done:{order_id}"
    if r.exists(done_key):  # idempotency: never forward the same order twice
        return {"order_id": order_id, "status": "already_forwarded"}

    try:
        with get_taager_breaker().guard():
            result = _call_taager(order_id, payload)
    except CircuitOpenError as exc:
        # Fail fast: we did NOT call Taager. But don't drop the order - reschedule it for just
        # after the breaker's recovery window. (This uses one retry; with 8 retries and a 60s
        # window that tolerates roughly 8+ minutes of outage before the order is marked failed.)
        logger.warning("Order %s deferred: %s", order_id, exc)
        raise self.retry(exc=exc, countdown=exc.retry_after + random.randint(0, 15))

    r.set(done_key, str(result.get("taager_order_id", "1")), ex=DONE_MARKER_TTL)
    _set_order_status(order_id, ORDER_STATUS_FORWARDED)
    logger.info("Order %s forwarded to Taager (attempt %d)", order_id, self.request.retries + 1)
    return {"order_id": order_id, "status": "forwarded", **result}
