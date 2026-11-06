/**
 * Edge rate limiting for POST /api/checkout: max 5 requests / minute / IP.
 *
 * Next.js 16 note: `middleware.ts` still works but is deprecated in favour of `proxy.ts`
 * (which runs on Node.js only - no Edge). To migrate, rename this file to `proxy.ts` and
 * the exported function `middleware` to `proxy`. Nothing below needs Node or Edge APIs.
 *
 * Storage:
 *  - If KV_REST_API_URL / KV_REST_API_TOKEN (or the UPSTASH_REDIS_REST_* pair) are set, counters
 *    live in Redis over REST, so every edge instance shares them (real protection).
 *  - Otherwise an in-memory Map is used. That is PER EDGE INSTANCE and resets on cold start,
 *    so it only stops casual spam. Fine for local dev, not a DDoS shield.
 *
 * Fixed window: at a window boundary a client can burst up to 2x the limit. Acceptable here.
 */
import { NextResponse, type NextRequest } from 'next/server';

const LIMIT = 5;
const WINDOW_SECONDS = 60;
const MAX_TRACKED_IPS = 10_000;

type LimitResult = { allowed: boolean; remaining: number; resetInSeconds: number };

// ---- In-memory fallback ------------------------------------------------------------------
const hits = new Map<string, { count: number; resetAt: number }>();

function memoryLimit(key: string): LimitResult {
  const now = Date.now();

  if (hits.size >= MAX_TRACKED_IPS) {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k); // drop expired windows
    if (hits.size >= MAX_TRACKED_IPS) {
      const oldest = hits.keys().next().value; // Map keeps insertion order
      if (oldest !== undefined) hits.delete(oldest);
    }
  }

  let entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_SECONDS * 1000 };
    hits.set(key, entry);
  }
  entry.count += 1;

  return {
    allowed: entry.count <= LIMIT,
    remaining: Math.max(LIMIT - entry.count, 0),
    resetInSeconds: Math.max(Math.ceil((entry.resetAt - now) / 1000), 1),
  };
}

// ---- Redis over REST (Upstash / Vercel Marketplace Redis) -------------------------------
type RedisReply = { result?: number; error?: string };

async function redisLimit(key: string): Promise<LimitResult | null> {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500); // never let the limiter slow checkout down
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, WINDOW_SECONDS, 'NX'], // start the window on the first hit only
        ['TTL', key],
      ]),
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const [incr, , ttl] = (await res.json()) as RedisReply[];
    if (typeof incr?.result !== 'number' || incr.error) return null;

    const count = incr.result;
    const resetInSeconds = typeof ttl?.result === 'number' && ttl.result > 0 ? ttl.result : WINDOW_SECONDS;
    return { allowed: count <= LIMIT, remaining: Math.max(LIMIT - count, 0), resetInSeconds };
  } catch {
    return null; // Redis down or slow -> fall back to memory instead of blocking customers
  } finally {
    clearTimeout(timer);
  }
}

// ---- Helpers ------------------------------------------------------------------------------
/**
 * On Vercel these headers are set by the platform and can be trusted. Behind your own
 * reverse proxy, make sure it OVERWRITES x-forwarded-for rather than appending to it.
 */
function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-real-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

// ---- Middleware ---------------------------------------------------------------------------
export async function middleware(req: NextRequest) {
  if (req.method !== 'POST') return NextResponse.next();

  const key = `ratelimit:checkout:${clientIp(req)}`;
  const result = (await redisLimit(key)) ?? memoryLimit(key);

  const rateHeaders = {
    'X-RateLimit-Limit': String(LIMIT),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetInSeconds),
  };

  if (!result.allowed) {
    return NextResponse.json(
      {
        error: 'too_many_requests',
        message: `Too many checkout attempts. Please wait ${result.resetInSeconds}s and try again.`,
        retryAfter: result.resetInSeconds,
      },
      { status: 429, headers: { ...rateHeaders, 'Retry-After': String(result.resetInSeconds) } },
    );
  }

  return NextResponse.next({ headers: rateHeaders });
}

// Only run for the checkout endpoint: every other route skips the middleware entirely.
export const config = { matcher: '/api/checkout' };
