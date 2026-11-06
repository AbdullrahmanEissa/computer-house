const SUPABASE_STORAGE_HOST = 'xaewbrodkcblqeclpjpw.supabase.co';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone', // self-contained server in .next/standalone: small Docker image, no full node_modules

  images: {
    // Only the public bucket path of YOUR Supabase project - never a bare wildcard host.
    remotePatterns: [
      {
        protocol: 'https',
        hostname: SUPABASE_STORAGE_HOST,
        pathname: '/storage/v1/object/public/**',
      },
    ],
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 60 * 60 * 24, // keep optimized variants for 1 day (upload new files under new names)
  },

  // The browser calls /api/checkout on OUR origin, so src/middleware.ts can rate-limit it at the
  // edge first; only requests that pass are proxied to FastAPI. Rewrites run AFTER middleware, and
  // all headers (Idempotency-Key, sentry-trace, ...) are forwarded. Bonus: same-origin means no CORS.
  async rewrites() {
    const api = process.env.API_URL?.replace(/\/+$/, '');
    if (!api) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('API_URL is not set: /api/checkout would 404. Set it at build time.');
      }
      return [];
    }
    return [{ source: '/api/checkout', destination: `${api}/api/orders` }];
  },
};

export default nextConfig;
