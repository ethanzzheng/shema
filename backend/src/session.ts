/**
 * In-memory state for one room's broadcast session.
 * One Session per church room (keyed by slug, e.g. "grace-church");
 * created lazily by SessionManager. No database.
 *
 * Each Session owns its own listener registry, so audio/text fan-out is
 * scoped to the room — nothing ever crosses rooms.
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { Direction } from './direction-config';
import { GlossaryTerm } from './glossary/types';

export interface TranslationChunk {
  seq: number;
  korean: string;
  direct: string;
  sermon: string;
  timestamp: number;
}

export interface DebugMetrics {
  lastChunkSize: number;
  /** Last STT final → chunker dispatch (deliberate hold cost). */
  chunkerWaitMs: number;
  translationLatencyMs: number;
  /** Translation done → first TTS audio byte (includes TTS queue wait). */
  ttsFirstByteMs: number;
  ttsLatencyMs: number;
  e2eLatencyMs: number;
  sttConnected: boolean;
}

export class Session {
  readonly roomId: string;
  isActive = false;
  mode: 'fast' | 'smooth' = 'smooth';
  /** Translation direction of the current/last broadcast (set at start). */
  direction: Direction = 'ko-en';

  koreanBuffer = '';
  translationHistory: TranslationChunk[] = [];

  // Per-room socket registries. Broadcasters are tracked too so the
  // SessionManager can tell when a room is fully empty and reclaim it.
  private listeners = new Set<WebSocket>();
  private broadcasters = new Set<WebSocket>();

  /**
   * Identifies the current broadcast, so service-scope glossary terms can be
   * tied to it. Minted at start; null while off air. Sessions are otherwise
   * purely in-memory — this id exists only to key rows in the database.
   */
  broadcastId: string | null = null;

  /**
   * The church glossary as loaded when this broadcast started. Snapshotted
   * because it is rendered into the translator's CACHED system prompt, which
   * must not change mid-broadcast.
   */
  glossaryChurch: GlossaryTerm[] = [];

  /**
   * Service-scope terms, plus anything an operator adds while on air. Read per
   * translation and injected into the uncached user message, so edits take
   * effect on the next sentence without costing a prompt-cache miss.
   */
  glossaryLive: GlossaryTerm[] = [];

  /** Where glossaryChurch came from — 'env' means the database was unreachable. */
  glossarySource: 'db' | 'env' | null = null;

  constructor(roomId = 'default') {
    this.roomId = roomId;
  }

  /** Mint an id on demand, so terms can be staged before going on air. */
  ensureBroadcastId(): string {
    if (!this.broadcastId) this.broadcastId = randomUUID();
    return this.broadcastId;
  }

  /** Called once at broadcast start, after the glossary has been loaded. */
  setGlossary(church: GlossaryTerm[], live: GlossaryTerm[], source: 'db' | 'env'): void {
    this.glossaryChurch = church;
    this.glossaryLive = live;
    this.glossarySource = source;
  }

  /**
   * A term added during the broadcast always lands in the live tier, whatever
   * its scope. A church-scope term added now is stored permanently but must
   * not be folded into the cached system prompt until the next broadcast.
   */
  addLiveTerm(term: GlossaryTerm): void {
    this.glossaryLive = [...this.glossaryLive.filter((t) => t.id !== term.id), term];
  }

  /** Remove by id from both tiers; the church tier only takes effect next start. */
  removeGlossaryTerm(id: string): void {
    this.glossaryLive = this.glossaryLive.filter((t) => t.id !== id);
    this.glossaryChurch = this.glossaryChurch.filter((t) => t.id !== id);
  }

  /** Every term currently in force, for display at the desk. */
  get glossaryAll(): GlossaryTerm[] {
    const byId = new Map<string, GlossaryTerm>();
    for (const t of [...this.glossaryChurch, ...this.glossaryLive]) byId.set(t.id, t);
    return [...byId.values()];
  }

  metrics: DebugMetrics = {
    lastChunkSize: 0,
    chunkerWaitMs: 0,
    translationLatencyMs: 0,
    ttsFirstByteMs: 0,
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
    this.notifyListenerCount();
  }

  removeListener(ws: WebSocket): void {
    this.listenerProgress.delete(ws);
    if (this.listeners.delete(ws)) this.notifyListenerCount();
  }

  addBroadcaster(ws: WebSocket): void {
    this.broadcasters.add(ws);
    // Late-joining operator sees the current room size immediately.
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'listeners', count: this.listeners.size }));
    }
  }

  /** Push a JSON payload to every broadcaster in this room. */
  sendToBroadcasters(payload: unknown): void {
    const msg = JSON.stringify(payload);
    for (const ws of this.broadcasters) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  /** Tell every broadcaster how many congregants are connected right now. */
  private notifyListenerCount(): void {
    this.sendToBroadcasters({ type: 'listeners', count: this.listeners.size });
  }

  // ── Pews progress ──────────────────────────────────────────────────────────
  // Listeners report which seq their AUDIO is actually playing; the
  // broadcaster desk marks that row so the operator can see where the pews
  // are. With several listeners we report the most-behind one.
  private listenerProgress = new Map<WebSocket, number>();

  recordListenerProgress(ws: WebSocket, seq: number): void {
    if (this.listeners.has(ws)) this.listenerProgress.set(ws, seq);
  }

  /** The seq the most-behind listener is hearing right now (null = none). */
  get pewsSeq(): number | null {
    let min: number | null = null;
    for (const seq of this.listenerProgress.values()) {
      if (min === null || seq < min) min = seq;
    }
    return min;
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
   * When the last broadcast stopped (0 = never). A `start` shortly after a
   * stop is a RESUME (network blip + broadcaster auto-restart), not a new
   * sermon — the transcript must survive it.
   */
  lastStoppedAt = 0;

  /**
   * Tears down the pipeline (STT/chunker) of the connection that OWNS the
   * current broadcast. Set by that connection's start; invoked when another
   * connection's `start` takes over. Ownership is what keeps a zombie
   * broadcaster tab's disconnect from killing a live session it never owned
   * (observed live: an old backgrounded /speak tab flapping every ~60s
   * executed the real broadcast each time).
   */
  activeBroadcastTeardown: (() => void) | null = null;

  /**
   * Record a completed translation. The seq is assigned earlier, at dispatch
   * time (spoken order), by the chunker via nextSeq() — NOT here — so it
   * reflects spoken order rather than translation-completion order.
   *
   * The FULL broadcast transcript is kept (no truncation): it's sent to
   * late-joining/refreshing listeners so they get the whole sermon so far.
   * A full sermon is a few hundred short text entries — trivial memory.
   */
  addTranslation(chunk: TranslationChunk): TranslationChunk {
    this.translationHistory.push(chunk);
    return chunk;
  }

  /** Wipe the transcript (a genuinely new sermon is starting). */
  clearTranscript(): void {
    this.translationHistory = [];
  }

  /** The transcript in the shape listeners receive (Korean omitted). */
  /** English text of the most recently emitted translation, for restart detection. */
  lastTranslationText(): string {
    return this.translationHistory.length > 0
      ? this.translationHistory[this.translationHistory.length - 1].sermon
      : '';
  }

  transcriptForListeners(): { seq: number; direct: string; sermon: string; timestamp: number }[] {
    return this.translationHistory.map(({ seq, direct, sermon, timestamp }) => ({
      seq,
      direct,
      sermon,
      timestamp,
    }));
  }

  reset(): void {
    this.isActive = false;
    this.direction = 'ko-en';
    this.koreanBuffer = '';
    this.translationHistory = [];
    this.seq = 0;
    this.metrics = {
      lastChunkSize: 0,
      chunkerWaitMs: 0,
      translationLatencyMs: 0,
      ttsFirstByteMs: 0,
      ttsLatencyMs: 0,
      e2eLatencyMs: 0,
      sttConnected: false,
    };
  }
}
