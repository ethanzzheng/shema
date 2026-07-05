/**
 * Phase A staff auth — env-config users, signed session tokens, no database.
 *
 *   AUTH_USERS  = JSON map of username → bcrypt password hash, e.g.
 *                 {"hanmaum":"$2b$10$abc..."}
 *   AUTH_SECRET = HMAC secret for signing session JWTs (any long random string)
 *
 * POST /login checks credentials against AUTH_USERS and returns a JWT
 * (12h expiry). Starting a broadcast requires that JWT. With NEITHER var
 * configured, broadcasting stays open (local dev). Listeners never need auth.
 * Real accounts + a database are Phase B.
 */

import * as bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const TOKEN_TTL = '12h';

interface AuthEnv {
  AUTH_USERS?: string;
  AUTH_SECRET?: string;
}

function parseUsers(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  try {
    const obj = JSON.parse(raw);
    for (const [user, hash] of Object.entries(obj)) {
      if (typeof hash === 'string' && user) map.set(user, hash);
    }
  } catch {
    console.error('[Auth] AUTH_USERS is not valid JSON — logins will fail');
  }
  return map;
}

/** True when auth is configured; false = open mode (local dev). */
export function authEnabled(env: AuthEnv = process.env): boolean {
  return Boolean(env.AUTH_SECRET && parseUsers(env.AUTH_USERS).size > 0);
}

/**
 * Validate a username/password. Returns a signed session token on success,
 * null on failure (unknown user, wrong password, or auth not configured).
 */
export function login(
  username: unknown,
  password: unknown,
  env: AuthEnv = process.env,
): string | null {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (!env.AUTH_SECRET) return null;
  const hash = parseUsers(env.AUTH_USERS).get(username.trim());
  // Burn a comparison even for unknown users so response timing doesn't
  // reveal which usernames exist.
  const target = hash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = bcrypt.compareSync(password, target);
  if (!ok || !hash) return null;
  return jwt.sign({ sub: username.trim() }, env.AUTH_SECRET, { expiresIn: TOKEN_TTL });
}

/** The username inside a valid, unexpired session token; null otherwise. */
export function verifyToken(token: unknown, env: AuthEnv = process.env): string | null {
  if (typeof token !== 'string' || !token || !env.AUTH_SECRET) return null;
  try {
    const payload = jwt.verify(token, env.AUTH_SECRET);
    const sub = typeof payload === 'object' && payload ? payload.sub : null;
    return typeof sub === 'string' && sub ? sub : null;
  } catch {
    return null; // bad signature, malformed, or expired
  }
}

/**
 * Broadcast gate: with auth configured, only a valid session token may start
 * a broadcast; in open mode (dev) everything is allowed.
 */
export function isStartAuthorized(
  token: unknown,
  env: AuthEnv = process.env,
): { ok: true; username: string | null } | { ok: false; reason: string } {
  if (!authEnabled(env)) return { ok: true, username: null };
  const username = verifyToken(token, env);
  if (!username) {
    return { ok: false, reason: 'Session invalid or expired — log in again to broadcast.' };
  }
  return { ok: true, username };
}
