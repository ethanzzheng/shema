'use client';

// Registers the app-shell service worker in production. In dev it does the
// OPPOSITE: it unregisters any worker left behind by a production run on the
// same origin (e.g. localhost:3000). A stale SW serving cache-first
// /_next/static/ assets against a dev server — whose chunk URLs are unhashed —
// pins old JS forever and causes hydration mismatches.
import { useEffect } from 'react';

export default function RegisterSW() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    if (process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    } else {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .then((unregistered) => {
          if (unregistered.some(Boolean)) {
            caches?.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
            console.warn('[SW] Unregistered stale service worker (dev mode) — reload once if the page misbehaves.');
          }
        })
        .catch(() => {});
    }
  }, []);
  return null;
}
