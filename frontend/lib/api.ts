import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

export interface Product {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  price: number;
  image_url: string | null;
}

export interface CheckoutItem {
  product_id?: string;
  bundle_id?: string;
  quantity: number;
  unit_price: number;
}

export interface CheckoutPayload {
  customer_id: string;
  customer_name: string;
  contact_phone: string;
  shipping_address: string | Record<string, unknown>;
  items: CheckoutItem[];
}

export interface CheckoutResponse {
  order_id: string;
  status: string;
  idempotent_replay: boolean;
}

export const REVALIDATE_SECONDS = 3600;
export const PRODUCTS_TAG = 'products';

function serverBaseUrl(): string {
  const url = process.env.API_URL;
  if (!url) throw new Error('API_URL is not set');
  return url.replace(/\/+$/, '');
}

async function apiGet<T>(path: string, tags: string[]): Promise<T | null> {
  let res;
  try {
    res = await fetch(`${serverBaseUrl()}${path}`, {
      headers: { Accept: 'application/json' },
      next: { revalidate: REVALIDATE_SECONDS, tags },
    });
  } catch (error) {
    console.warn(`[Build Warning] Failed to fetch API at ${path} - skipping during build.`);
    return null;
  }
  
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`FastAPI ${res.status} on GET ${path}`);
  return (await res.json()) as T;
}

export async function getProducts(): Promise<Product[]> {
  return (await apiGet<Product[]>('/api/products', [PRODUCTS_TAG])) ?? [];
}

export async function getProduct(slug: string): Promise<Product | null> {
  return apiGet<Product>(`/api/products/${encodeURIComponent(slug)}`, [
    PRODUCTS_TAG,
    `product:${slug}`,
  ]);
}

export type CheckoutErrorKind =
  | 'validation'
  | 'conflict'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'unknown';

export class CheckoutError extends Error {
  readonly kind: CheckoutErrorKind;
  readonly retryAfter?: number;

  constructor(kind: CheckoutErrorKind, message: string, retryAfter?: number) {
    super(message);
    this.name = 'CheckoutError';
    this.kind = kind;
    this.retryAfter = retryAfter;
  }
}

export function generateIdempotencyKey(): string {
  return uuidv4();
}

const http = axios.create({
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

export async function createOrder(
  payload: CheckoutPayload,
  idempotencyKey: string,
): Promise<CheckoutResponse> {
  try {
    const { data } = await http.post<CheckoutResponse>('/api/checkout', payload, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    return data;
  } catch (err) {
    throw toCheckoutError(err);
  }
}

function extractDetail(data: unknown): string | undefined {
  const body = data as { detail?: unknown; message?: unknown } | null;
  if (typeof body?.detail === 'string') return body.detail;
  if (Array.isArray(body?.detail)) {
    const msgs = body.detail.map((d: { msg?: string }) => d?.msg).filter(Boolean);
    if (msgs.length) return msgs.join('; ');
  }
  return typeof body?.message === 'string' ? body.message : undefined;
}

function toCheckoutError(err: unknown): CheckoutError {
  if (!axios.isAxiosError(err)) return new CheckoutError('unknown', 'Something went wrong. Please try again.');

  const res = err.response;
  if (!res) {
    return new CheckoutError(
      'network',
      'Connection problem. Press "Place order" again: we make sure your order is only placed once.',
    );
  }

  const detail = extractDetail(res.data);
  switch (true) {
    case res.status === 429: {
      const retryAfter = Number(res.headers['retry-after']) || undefined;
      return new CheckoutError(
        'rate_limited',
        detail ?? `Too many attempts. Please wait ${retryAfter ?? 60}s and try again.`,
        retryAfter,
      );
    }
    case res.status === 400 || res.status === 422:
      return new CheckoutError('validation', detail ?? 'Please check your details and try again.');
    case res.status === 409:
      return new CheckoutError('conflict', detail ?? 'This order conflicts with an earlier request.');
    case res.status >= 500:
      return new CheckoutError('server', 'Our server hit a problem. Please try again in a moment: your order won\'t be duplicated.');
    default:
      return new CheckoutError('unknown', detail ?? 'Something went wrong. Please try again.');
  }
}
