// Liveness probe for Docker / load balancers.
// Deliberately does NOT call FastAPI: if the backend is down, the storefront can still serve its
// cached (ISR) pages, so the container must not be reported unhealthy.
export function GET() {
  return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
