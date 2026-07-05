/**
 * Phase A broadcast protection — per-room host keys from env, no database.
 *
 *   ROOM_HOST_KEYS="grace-church:abc123,hanmaeum:xyz789"  → per-room keys
 *   BROADCAST_HOST_KEY="shared-secret"                    → one key, all rooms
 *
 * ROOM_HOST_KEYS wins for rooms it names; BROADCAST_HOST_KEY covers the rest.
 * With neither set, broadcasting is open (local dev). Listeners never need a
 * key. Phase B replaces this with real accounts.
 */

import { timingSafeEqual } from 'crypto';

function parseRoomKeys(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (raw ?? '').split(',')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const room = pair.slice(0, idx).trim();
    const key = pair.slice(idx + 1).trim();
    if (room && key) map.set(room, key);
  }
  return map;
}

/** The key required to broadcast in `roomId`, or null if the room is open. */
export function requiredHostKey(
  roomId: string,
  env: { ROOM_HOST_KEYS?: string; BROADCAST_HOST_KEY?: string } = process.env,
): string | null {
  const perRoom = parseRoomKeys(env.ROOM_HOST_KEYS);
  return perRoom.get(roomId) ?? (env.BROADCAST_HOST_KEY?.trim() || null);
}

/** Constant-time comparison; length mismatch handled without early exit on content. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** True if `provided` unlocks broadcasting in `roomId`. */
export function isHostKeyValid(
  roomId: string,
  provided: unknown,
  env: { ROOM_HOST_KEYS?: string; BROADCAST_HOST_KEY?: string } = process.env,
): boolean {
  const required = requiredHostKey(roomId, env);
  if (required === null) return true; // room is open (no key configured)
  return typeof provided === 'string' && safeEqual(provided.trim(), required);
}
