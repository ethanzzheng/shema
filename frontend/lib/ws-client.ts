/**
 * Typed WebSocket client for the Shema backend.
 * Handles reconnection and message dispatch.
 */

export type WsRole = 'broadcaster' | 'listener';

// ── Message shapes ─────────────────────────────────────────────────────────

export interface TranscriptMsg {
  type: 'transcript';
  korean: string;
  isFinal: boolean;
  timestamp: number;
}

export interface TranslationMsg {
  type: 'translation';
  seq: number;
  korean?: string;
  direct: string;
  sermon: string;
  timestamp: number;
}

export interface AudioMsg {
  type: 'audio';
  seq: number;
  data: string; // base64 MP3
  format: 'mp3';
}

// ── Streaming TTS protocol (MP3 chunks forwarded as they synthesise) ────────
export interface AudioStartMsg {
  type: 'audio_start';
  seq: number;
}

export interface AudioChunkMsg {
  type: 'audio_chunk';
  seq: number;
  data: string; // base64 MP3 chunk
}

export interface AudioEndMsg {
  type: 'audio_end';
  seq: number;
}

export interface StatusMsg {
  type: 'status';
  active?: boolean;
  sttConnected?: boolean;
}

/** Sent to broadcasters whenever the room's listener count changes. */
export interface ListenersMsg {
  type: 'listeners';
  count: number;
}

/**
 * Full transcript of the current broadcast, sent to a listener on connect
 * (late join / refresh) and broadcast with empty chunks when a new sermon
 * starts. Authoritative: replaces local transcript state.
 */
export interface TranscriptHistoryMsg {
  type: 'transcript_history';
  chunks: { seq: number; direct: string; sermon: string; timestamp: number }[];
}

export interface DebugMsg {
  type: 'debug';
  chunkSize: number;
  translationLatencyMs: number;
  ttsLatencyMs: number;
  e2eLatencyMs: number;
  sttConnected: boolean;
}

export interface ErrorMsg {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | TranscriptMsg
  | TranslationMsg
  | AudioMsg
  | AudioStartMsg
  | AudioChunkMsg
  | AudioEndMsg
  | StatusMsg
  | ListenersMsg
  | TranscriptHistoryMsg
  | DebugMsg
  | ErrorMsg
  | { type: string; [key: string]: unknown };

// ── Client ─────────────────────────────────────────────────────────────────

export interface WsClientOptions {
  url: string;
  role: WsRole;
  /** Church room slug (e.g. "grace-church"). Backend defaults to "default". */
  room?: string;
  onMessage: (msg: ServerMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Event) => void;
  reconnectDelayMs?: number;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private opts: WsClientOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldConnect = false;
  private connected = false;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  connect(): void {
    this.shouldConnect = true;
    this.openConnection();
  }

  private openConnection(): void {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    const params = new URLSearchParams({ role: this.opts.role });
    if (this.opts.room) params.set('room', this.opts.room);
    const url = `${this.opts.url}?${params.toString()}`;

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.connected = true;
      this.opts.onOpen?.();
    });

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg: ServerMessage = JSON.parse(ev.data);
          this.opts.onMessage(msg);
        } catch {
          console.error('[WsClient] Failed to parse message');
        }
      }
      // Binary frames not expected for listeners/broadcaster control channel
    });

    ws.addEventListener('close', () => {
      this.connected = false;
      this.opts.onClose?.();
      if (this.shouldConnect) {
        this.scheduleReconnect();
      }
    });

    ws.addEventListener('error', (ev) => {
      this.opts.onError?.(ev);
    });
  }

  sendJSON(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  sendBinary(data: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  /**
   * Tear down the current socket and let the reconnect logic rebuild it.
   * For half-dead connections (flaky hotspot/Wi-Fi): the socket still says
   * OPEN but nothing flows, so a heartbeat that stops seeing replies calls
   * this instead of trusting readyState.
   */
  forceReconnect(): void {
    if (!this.shouldConnect) return;
    try { this.ws?.close(); } catch {}
  }

  disconnect(): void {
    this.shouldConnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, 'Disconnect'); } catch {}
      this.ws = null;
    }
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.opts.reconnectDelayMs ?? 2000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldConnect) this.openConnection();
    }, delay);
  }
}
