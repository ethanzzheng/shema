/**
 * Client side of the Phase A staff login.
 *
 * The session JWT lives in sessionStorage — survives refreshes during a
 * service, gone when the tab closes, never persisted to disk. The client
 * only decodes the token's expiry for UX gating; the backend signature
 * check on the WebSocket is the real security boundary.
 */

import { getBackendHttpUrl } from './backend-config';

const TOKEN_KEY = 'shema-session-token';
const USERNAME_KEY = 'shema-session-user';

export function getToken(): string | null {
  try { return window.sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function getUsername(): string | null {
  try { return window.sessionStorage.getItem(USERNAME_KEY); } catch { return null; }
}

export function saveSession(token: string, username: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
    window.sessionStorage.setItem(USERNAME_KEY, username);
  } catch {}
}

export function clearSession(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(USERNAME_KEY);
  } catch {}
}

/** JWT exp (seconds since epoch), or null if unreadable. */
function tokenExp(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** True if we hold a token that hasn't expired (60s slack for clock skew). */
export function hasValidSession(): boolean {
  const token = getToken();
  if (!token) return false;
  const exp = tokenExp(token);
  return exp !== null && exp * 1000 > Date.now() + 60_000;
}

/** Whether the backend enforces login (false = open dev mode). */
export async function backendRequiresAuth(): Promise<boolean> {
  try {
    const res = await fetch(`${getBackendHttpUrl()}/health`, { cache: 'no-store' });
    const health = await res.json();
    return health.authRequired === true;
  } catch {
    // Backend unreachable: don't trap the user on /login — let the page load
    // and surface the connection problem itself.
    return false;
  }
}

export async function loginRequest(
  username: string,
  password: string,
): Promise<{ ok: true; token: string; username: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${getBackendHttpUrl()}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: body.error ?? `Login failed (${res.status})` };
    }
    return { ok: true, token: body.token, username: body.username };
  } catch {
    return { ok: false, error: 'Could not reach the server — check your connection.' };
  }
}
