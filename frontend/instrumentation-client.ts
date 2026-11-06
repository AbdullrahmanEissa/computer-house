/**
 * Sentry - browser runtime.
 * This is the current name of `sentry.client.config.ts` (Sentry says it is safe to rename it, and
 * the old file isn't picked up when building with Turbopack, the default in Next.js 16).
 */
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, // no DSN => the SDK stays disabled (handy locally)
  environment: process.env.NEXT_PUBLIC_ENVIRONMENT ?? process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
   // checkout forms hold names, phones and addresses: keep them out
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'ResizeObserver loop completed with undelivered notifications.',
  ],
});

// Lets Sentry trace client-side navigations in the App Router.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
