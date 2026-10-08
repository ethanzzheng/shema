/**
 * Room registry — lazily creates one Session per roomId (church slug) and
 * reclaims a room once its broadcaster has disconnected and no listeners
 * remain. Everything stays in memory; multi-church = more rooms, not more
 * infrastructure.
 */

import { Session } from './session';
import { Direction } from './direction-config';

/** Room slugs are lowercase kebab-case; anything else is normalized to it. */
export function normalizeRoomId(raw: string | null | undefined): string {
  const slug = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'default';
}

export interface RoomStats {
  listeners: number;
  broadcasting: boolean;
  direction: Direction;
}

export class SessionManager {
  private rooms = new Map<string, Session>();

  /** Get the room's session, creating it on first touch. */
  getOrCreate(roomId: string): Session {
    let session = this.rooms.get(roomId);
    if (!session) {
      session = new Session(roomId);
      this.rooms.set(roomId, session);
      console.log(`[Rooms] Created room "${roomId}" (${this.rooms.size} total)`);
    }
    return session;
  }

  get(roomId: string): Session | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Drop the room if nobody is left in it. Called after any socket in the
   * room closes — socket removal handlers run first (they were registered
   * first), so the emptiness check here sees the post-disconnect state.
   */
  maybeCleanup(roomId: string): void {
    const session = this.rooms.get(roomId);
    if (session && session.isEmpty) {
      this.rooms.delete(roomId);
      console.log(`[Rooms] Reclaimed empty room "${roomId}" (${this.rooms.size} left)`);
    }
  }

  /**
   * Drop expired demo rooms.
   *
   * Emptiness alone is not enough for a demo: a prospect who closes the tab
   * mid-session leaves nothing behind, but one who leaves it open walks away
   * from a room that would otherwise live as long as the process. A demo is
   * time-boxed by definition, so it expires whether or not anyone is in it.
   *
   * Only ever touches rooms in the demo namespace.
   */
  reapExpiredDemos(now = Date.now()): number {
    let reaped = 0;
    for (const [roomId, session] of this.rooms) {
      if (!session.demo) continue;
      if (session.demo.expiresAt > now) continue;
      session.closeAll(1000, 'Demo session expired');
      this.rooms.delete(roomId);
      reaped++;
    }
    if (reaped > 0) console.log(`[Demo] Expired ${reaped} demo room(s) (${this.rooms.size} left)`);
    return reaped;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get totalListeners(): number {
    let n = 0;
    for (const s of this.rooms.values()) n += s.listenerCount;
    return n;
  }

  /** Per-room snapshot for /health. */
  stats(): Record<string, RoomStats> {
    const out: Record<string, RoomStats> = {};
    for (const [id, s] of this.rooms) {
      out[id] = { listeners: s.listenerCount, broadcasting: s.isActive, direction: s.direction };
    }
    return out;
  }
}
