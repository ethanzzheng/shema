/**
 * In-memory state for one room's broadcast session.
 * One Session per church room (keyed by slug, e.g. "grace-church");
 * created lazily by SessionManager. No database.
 *
 * Each Session owns its own listener registry, so audio/text fan-out is
 * scoped to the room — nothing ever crosses rooms.
 */

import { WebSocket } from 'ws';

export interface TranslationChunk {
  seq: number;
  korean: string;
  direct: string;
  sermon: string;
  timestamp: number;
}

export interface DebugMetrics {
  lastChunkSize: number;
  translationLatencyMs: number;
  ttsLatencyMs: number;
  e2eLatencyMs: number;
  sttConnected: boolean;
}

export class Session {
  readonly roomId: string;
  isActive = false;
  mode: 'fast' | 'smooth' = 'smooth';

  koreanBuffer = '';
  translationHistory: TranslationChunk[] = [];

  // Per-room socket registries. Broadcasters are tracked too so the
  // SessionManager can tell when a room is fully empty and reclaim it.
  private listeners = new Set<WebSocket>();
  private broadcasters = new Set<WebSocket>();

  constructor(roomId = 'default') {
    this.roomId = roomId;
  }

  metrics: DebugMetrics = {
    lastChunkSize: 0,
    translationLatencyMs: 0,
    ttsLatencyMs: 0,
    e2eLatencyMs: 0,
    sttConnected: false,
  };

  private seq = 0;

  nextSeq(): number {
    return ++this.seq;
  }

  // ── Room membership ────────────────────────────────────────────────────────

  addListener(ws: WebSocket): void {
    this.listeners.add(ws);
  }

  removeListener(ws: WebSocket): void {
    this.listeners.delete(ws);
  }

  addBroadcaster(ws: WebSocket): void {
    this.broadcasters.add(ws);
  }

  removeBroadcaster(ws: WebSocket): void {
    this.broadcasters.delete(ws);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  get broadcasterCount(): number {
    return this.broadcasters.size;
  }

  get isEmpty(): boolean {
    return this.listeners.size === 0 && this.broadcasters.size === 0;
  }

  /**
   * Push a JSON payload to every listener in THIS room.
   * Stale (closed) sockets are removed automatically.
   */
  broadcast(payload: unknown): void {
    const msg = JSON.stringify(payload);
    for (const ws of this.listeners) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      } else {
        this.listeners.delete(ws);
      }
    }
  }

  /**
   * Record a completed translation. The seq is assigned earlier, at dispatch
   * time (spoken order), by the chunker via nextSeq() — NOT here — so it
   * reflects spoken order rather than translation-completion order.
   */
  addTranslation(chunk: TranslationChunk): TranslationChunk {
    // Keep last 50 chunks in memory
    this.translationHistory.push(chunk);
    if (this.translationHistory.length > 50) {
      this.translationHistory.shift();
    }
    return chunk;
  }

  reset(): void {
    this.isActive = false;
    this.koreanBuffer = '';
    this.translationHistory = [];
    this.seq = 0;
    this.metrics = {
      lastChunkSize: 0,
      translationLatencyMs: 0,
      ttsLatencyMs: 0,
      e2eLatencyMs: 0,
      sttConnected: false,
    };
  }
}
