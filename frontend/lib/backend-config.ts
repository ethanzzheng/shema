/**
 * Single source of truth for backend URLs.
 *
 * Production (Vercel): set NEXT_PUBLIC_BACKEND_WS_URL / NEXT_PUBLIC_BACKEND_HTTP_URL
 * to the Railway backend (wss://api.tryshema.app/ws, https://api.tryshema.app).
 *
 * Local dev: leave both unset — URLs are derived from the page's hostname so
 * the two-laptop LAN setup (http://SERVER_IP:3000 → SERVER_IP:3001) keeps
 * working without any config.
 *
 * Only call these client-side (they read window when the env vars are unset).
 */

const DEV_BACKEND_PORT = 3001;

export function getBackendWsUrl(): string {
  if (process.env.NEXT_PUBLIC_BACKEND_WS_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_WS_URL;
  }
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.hostname}:${DEV_BACKEND_PORT}/ws`;
}

export function getBackendHttpUrl(): string {
  if (process.env.NEXT_PUBLIC_BACKEND_HTTP_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_HTTP_URL;
  }
  const proto = window.location.protocol === 'https:' ? 'https' : 'http';
  return `${proto}://${window.location.hostname}:${DEV_BACKEND_PORT}`;
}
