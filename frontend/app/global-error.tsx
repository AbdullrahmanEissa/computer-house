'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

// Replaces the root layout when it crashes, so it must render its own <html> and <body>.
// Plain inline styles on purpose: the layout's global CSS may not be loaded here.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', textAlign: 'center', padding: '4rem 1rem' }}>
        <h1>Something went wrong</h1>
        <p>We&apos;ve been notified and are looking into it.</p>
        <button onClick={reset} style={{ marginTop: '1rem', padding: '0.5rem 1rem' }}>
          Try again
        </button>
      </body>
    </html>
  );
}
