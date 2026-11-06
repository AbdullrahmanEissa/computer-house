'use client';

import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react';
import { CircleAlert, CircleCheck, LoaderCircle, ShieldCheck } from 'lucide-react';
import {
  CheckoutError,
  createOrder,
  generateIdempotencyKey,
  type CheckoutItem,
  type CheckoutPayload,
  type CheckoutResponse,
} from '@/lib/api';

const CURRENCY = 'EGP';
const money = new Intl.NumberFormat('en-EG', { style: 'currency', currency: CURRENCY });

// ---------------------------------------------------------------------------
// Idempotency key lifecycle
//
// The key is created lazily on the first submit (BEFORE the network call) and is tied to a
// fingerprint of the order. Same order => same key, so retrying after a timeout, a 5xx or a 429
// can never create a second order. The order changes (new cart / edited details) => new key.
// ---------------------------------------------------------------------------
function useIdempotencyKey(fingerprint: string) {
  const ref = useRef<{ fingerprint: string; key: string } | null>(null);

  const get = useCallback(() => {
    if (!ref.current || ref.current.fingerprint !== fingerprint) {
      ref.current = { fingerprint, key: generateIdempotencyKey() };
    }
    return ref.current.key;
  }, [fingerprint]);

  const reset = useCallback(() => {
    ref.current = null;
  }, []);

  return { get, reset };
}

// ---------------------------------------------------------------------------
type Fields = { name: string; phone: string; address: string };
type FieldErrors = Partial<Record<keyof Fields, string>>;

function validate(v: Fields): FieldErrors {
  const errors: FieldErrors = {};
  if (v.name.trim().length < 2) errors.name = 'Enter your full name.';
  if (!/^\+?\d{8,15}$/.test(v.phone.replace(/[\s\-()]/g, ''))) {
    errors.phone = 'Enter a valid phone number (8-15 digits).';
  }
  if (v.address.trim().length < 10) errors.address = 'Enter your full delivery address.';
  return errors;
}

interface CheckoutFormProps {
  customerId: string; // from your auth/session layer
  items: CheckoutItem[]; // from your cart
  onSuccess?: (order: CheckoutResponse) => void;
}

export default function CheckoutForm({ customerId, items, onSuccess }: CheckoutFormProps) {
  const [fields, setFields] = useState<Fields>({ name: '', phone: '', address: '' });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [order, setOrder] = useState<CheckoutResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlight = useRef(false); // blocks double-clicks in the same tick, before state updates land

  const payload: CheckoutPayload = useMemo(
    () => ({
      customer_id: customerId,
      customer_name: fields.name.trim(),
      contact_phone: fields.phone.trim(),
      shipping_address: fields.address.trim(),
      items,
    }),
    [customerId, fields, items],
  );
  const idempotency = useIdempotencyKey(JSON.stringify(payload));

  const total = useMemo(
    () => items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0),
    [items],
  ); // display only: the backend recomputes the real total

  function update(field: keyof Fields, value: string) {
    setFields((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current || items.length === 0) return;

    const errors = validate(fields);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    inFlight.current = true;
    setSubmitting(true);
    setFormError(null);

    try {
      const key = idempotency.get(); // key exists before the request leaves the browser
      const result = await createOrder(payload, key);
      idempotency.reset(); // that order is done; the next checkout gets a brand-new key
      setOrder(result);
      onSuccess?.(result);
    } catch (err) {
      // The key is NOT reset here, so pressing "Place order" again re-sends the same key.
      setFormError(err instanceof CheckoutError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  // ---- Success view -----------------------------------------------------------------------
  if (order) {
    return (
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-6 text-center text-zinc-100">
        <CircleCheck className="mx-auto mb-3 h-10 w-10 text-emerald-400" aria-hidden />
        <h2 className="text-xl font-semibold">Order received!</h2>
        <p className="mt-2 text-sm text-zinc-300">
          Your order number is{' '}
          <span className="font-mono font-semibold text-emerald-300">
            #{order.order_id.slice(0, 8).toUpperCase()}
          </span>
          . We&apos;ll message you on WhatsApp shortly.
        </p>
      </div>
    );
  }

  // ---- Form -------------------------------------------------------------------------------
  const inputClass = (invalid: boolean) =>
    `mt-1 w-full rounded-lg border bg-zinc-950 px-3 py-2 text-zinc-100 placeholder-zinc-500 outline-none transition focus:ring-2 focus:ring-violet-500 ${
      invalid ? 'border-red-500' : 'border-zinc-700 focus:border-violet-500'
    }`;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="mx-auto w-full max-w-md space-y-5 rounded-2xl border border-zinc-800 bg-zinc-900 p-6 text-zinc-100 shadow-xl"
    >
      <h2 className="text-xl font-semibold">Checkout</h2>

      <div>
        <label htmlFor="name" className="text-sm font-medium text-zinc-300">Full name</label>
        <input
          id="name"
          autoComplete="name"
          value={fields.name}
          onChange={(e) => update('name', e.target.value)}
          aria-invalid={!!fieldErrors.name}
          aria-describedby={fieldErrors.name ? 'name-error' : undefined}
          className={inputClass(!!fieldErrors.name)}
          placeholder="Your name"
        />
        {fieldErrors.name && <p id="name-error" className="mt-1 text-xs text-red-400">{fieldErrors.name}</p>}
      </div>

      <div>
        <label htmlFor="phone" className="text-sm font-medium text-zinc-300">Phone (WhatsApp)</label>
        <input
          id="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={fields.phone}
          onChange={(e) => update('phone', e.target.value)}
          aria-invalid={!!fieldErrors.phone}
          aria-describedby={fieldErrors.phone ? 'phone-error' : undefined}
          className={inputClass(!!fieldErrors.phone)}
          placeholder="01012345678"
        />
        {fieldErrors.phone && <p id="phone-error" className="mt-1 text-xs text-red-400">{fieldErrors.phone}</p>}
      </div>

      <div>
        <label htmlFor="address" className="text-sm font-medium text-zinc-300">Delivery address</label>
        <textarea
          id="address"
          rows={3}
          autoComplete="street-address"
          value={fields.address}
          onChange={(e) => update('address', e.target.value)}
          aria-invalid={!!fieldErrors.address}
          aria-describedby={fieldErrors.address ? 'address-error' : undefined}
          className={inputClass(!!fieldErrors.address)}
          placeholder="Governorate, city, street, building, apartment"
        />
        {fieldErrors.address && <p id="address-error" className="mt-1 text-xs text-red-400">{fieldErrors.address}</p>}
      </div>

      <div className="flex items-center justify-between border-t border-zinc-800 pt-4 text-sm">
        <span className="text-zinc-400">
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </span>
        <span className="text-lg font-semibold">{money.format(total)}</span>
      </div>

      {formError && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{formError}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={submitting || items.length === 0}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-3 font-semibold text-white transition hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:ring-offset-2 focus:ring-offset-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? (
          <>
            <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden /> Placing order…
          </>
        ) : (
          'Place order'
        )}
      </button>

      <p className="flex items-center justify-center gap-1.5 text-xs text-zinc-500">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Safe to retry: your order is only placed once.
      </p>
    </form>
  );
}
