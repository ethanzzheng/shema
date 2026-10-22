/**
 * ElevenLabs Scribe real-time speech-to-text, for Cantonese.
 *
 * Deepgram's zh-HK model missed about 19% of what Cantonese preachers said;
 * Scribe missed about 7%, and on a real sermon its text gave the translator
 * cleaner, better-punctuated sentences (see the yue-en entry in
 * direction-config.ts). Same shape as DeepgramSTT, so the broadcaster can use
 * either: audio in, finals out, each stamped with where its words sit in the
 * audio.
 *
 * Scribe commits a transcript once the speaker has been quiet for
 * vad_silence_threshold_secs. Partials are not forwarded, as with Deepgram:
 * the chunker was tuned and measured on commits alone.
 *
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 */

import WebSocket from 'ws';
import type { SpeechToText, TranscriptEvent } from './stt';

interface ScribeWord {
  text: string;
  start: number;
  end: number;
  type: string;
}

/** Server messages that mean this session cannot go on. */
const FATAL = new Set(['auth_error', 'quota_exceeded', 'unaccepted_terms', 'invalid_request']);

export class ScribeSTT implements SpeechToText {
  private readonly apiKey: string;
  private readonly languageCode: string;
  private readonly vadSilenceSecs: number;
  private readonly noVerbatim: boolean;
  private readonly keyterms: string[];
  private readonly baseUrl: string;
  private readonly onTranscript: (event: TranscriptEvent) => void;
  private readonly onError: (err: Error) => void;
  private readonly onStatusChange: (connected: boolean) => void;
  /** Called once if Scribe cannot be used at all, so the caller can switch recognizer. */
  private readonly onUnavailable: ((reason: string) => void) | undefined;
  /** Rewrites committed text before it leaves (Traditional characters, for one). */
  private readonly transform: (text: string) => string;

  private ws: WebSocket | null = null;
  private running = false;
  /** The current socket has had its session_started. */
  private started = false;
  /** The first audio chunk of a socket may carry previous_text; later ones may not. */
  private firstChunk = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastMessageAt = 0;
  private lastPongAt = 0;
  private lastAudioSentAt = 0;
  /** Sockets in a row that closed before a session started. */
  private failedOpens = 0;
  private gaveUp = false;

  /** Text of recent commits, passed to a fresh session as context. */
  private previousText = '';

  // Audio continuity, as in DeepgramSTT: hold audio while no socket is open,
  // and on a dropped socket send again whatever Scribe heard but had not yet
  // committed. Scribe's word times restart at 0 with each session.
  private held: Buffer[] = [];
  private sentLog: { pcm: Buffer; startSec: number }[] = [];
  private sentSec = 0;
  /** End of the last committed word, on the current session's clock. */
  private committedEndSec = 0;

  private static readonly BYTES_PER_SEC = 32_000;
  private static readonly CONTINUITY_MAX_SEC = 20;
  private static readonly PING_INTERVAL_MS = 10_000;
  private static readonly PONG_TIMEOUT_MS = 45_000;
  /**
   * Audio flowing but no message at all for this long → assume hung. Scribe
   * sends partials while anyone speaks, so a quiet socket during speech is
   * dead; a reconnect during genuine silence costs nothing.
   */
  private static readonly SILENT_LINK_TIMEOUT_MS = 60_000;
  /** After this many failed opens in a row, give up and let the caller fall back. */
  private static readonly MAX_FAILED_OPENS = 3;

  // ── Long-commit cap ───────────────────────────────────────────────────────
  // Scribe commits only after vad_silence of quiet, and a preacher in full
  // flow can go 20s without one: on a real Cantonese sermon a single commit
  // ran 20.6s, and the listener heard that passage 19.7s late. Past
  // maxCommitSec of uncommitted speech, we commit ourselves on the next dip in
  // loudness (the gap between phrases, too short for Scribe's VAD), and
  // regardless at hardCommitSec. The chunker joins a mid-sentence commit to
  // the next, as it always has with Deepgram's finals.
  private readonly maxCommitSec: number;
  private readonly hardCommitSec: number;
  /** Text Scribe has heard since its last commit (its latest partial). */
  private pendingPartial = '';
  /** Running loudness of speech, to tell a dip between phrases. */
  private speechRms = 0;
  /** sentSec at our last forced commit, so one is not sent every chunk. */
  private forcedAtSec = -Infinity;

  constructor(opts: {
    apiKey: string;
    languageCode: string;
    vadSilenceSecs: number;
    noVerbatim: boolean;
    keyterms?: string[];
    transform?: (text: string) => string;
    /** Test seam only. */
    baseUrl?: string;
    onTranscript: (event: TranscriptEvent) => void;
    onError: (err: Error) => void;
    onStatusChange: (connected: boolean) => void;
    onUnavailable?: (reason: string) => void;
    /** Commit ourselves past this many seconds of uncommitted speech (0 = never). */
    maxCommitSec?: number;
  }) {
    this.maxCommitSec = opts.maxCommitSec ?? 10;
    this.hardCommitSec = this.maxCommitSec + 4;
    this.apiKey = opts.apiKey;
    this.languageCode = opts.languageCode;
    this.vadSilenceSecs = opts.vadSilenceSecs;
    this.noVerbatim = opts.noVerbatim;
    this.keyterms = (opts.keyterms ?? []).map((k) => k.trim()).filter(Boolean);
    this.transform = opts.transform ?? ((t) => t);
    this.baseUrl = opts.baseUrl ?? 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
    this.onTranscript = opts.onTranscript;
    this.onError = opts.onError;
    this.onStatusChange = opts.onStatusChange;
    this.onUnavailable = opts.onUnavailable;
  }

  get isConnected(): boolean {
    return this.running && this.started && this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.running) return;
    this.running = true;
    this.openConnection();
  }

  private openConnection(): void {
    if (!this.running) return;
    const params = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      language_code: this.languageCode,
      audio_format: 'pcm_16000',
      commit_strategy: 'vad',
      vad_silence_threshold_secs: String(this.vadSilenceSecs),
      include_timestamps: 'true',
      ...(this.noVerbatim ? { no_verbatim: 'true' } : {}),
    });
    for (const k of this.keyterms) params.append('keyterms', k);

    console.log(
      `[STT] Connecting to Scribe (${this.languageCode}, silence ${this.vadSilenceSecs}s` +
        `${this.noVerbatim ? ', no fillers' : ''}, ${this.keyterms.length} keyterms)`,
    );
    const ws = new WebSocket(`${this.baseUrl}?${params}`, { headers: { 'xi-api-key': this.apiKey } });
    this.ws = ws;
    this.started = false;
    this.firstChunk = true;

    ws.on('open', () => {
      this.committedEndSec = 0;
      this.forcedAtSec = -Infinity;
      this.pendingPartial = '';
      this.sentLog = [];
      this.sentSec = 0;
      this.startWatchdog();
    });
    ws.on('pong', () => {
      this.lastPongAt = Date.now();
    });
    ws.on('message', (data: WebSocket.Data) => {
      if (ws !== this.ws) return;
      this.lastMessageAt = Date.now();
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.handleMessage(msg);
    });
    ws.on('close', (code, reason) => {
      if (ws !== this.ws) return;
      console.log(`[STT] Scribe socket closed: ${code} ${reason.toString()}`);
      const wasStarted = this.started;
      this.started = false;
      this.stopWatchdog();
      this.onStatusChange(false);
      if (!this.running) return;
      if (!wasStarted && ++this.failedOpens >= ScribeSTT.MAX_FAILED_OPENS) {
        this.giveUp(`Scribe did not start after ${this.failedOpens} tries (last close ${code})`);
        return;
      }
      this.holdUncommitted();
      this.scheduleReconnect();
    });
    ws.on('error', (err) => {
      console.error('[STT] Scribe socket error:', err.message);
      this.onError(err);
    });
  }

  private handleMessage(msg: any): void {
    const type: string = msg.message_type ?? '';
    if (type === 'session_started') {
      console.log('[STT] Scribe session started');
      this.started = true;
      this.failedOpens = 0;
      this.flushHeld();
      this.onStatusChange(true);
      return;
    }
    if (type === 'committed_transcript_with_timestamps') {
      this.handleCommit(msg);
      return;
    }
    if (type === 'partial_transcript') {
      this.pendingPartial = String(msg.text ?? '');
      return;
    }
    if (type === 'committed_transcript' || type === 'warning') return;
    if (type === 'insufficient_audio_activity' || type === 'commit_throttled') return;
    if (type) {
      const detail = String(msg.error ?? msg.message ?? '').slice(0, 200);
      console.error(`[STT] Scribe ${type}: ${detail}`);
      this.onError(new Error(`Scribe ${type}${detail ? `: ${detail}` : ''}`));
      if (FATAL.has(type)) this.giveUp(`Scribe ${type}`);
    }
  }

  private handleCommit(msg: any): void {
    const words: ScribeWord[] = (Array.isArray(msg.words) ? msg.words : []).filter(
      (w: ScribeWord) => w?.type === 'word',
    );
    const raw = String(msg.text ?? '').trim();
    if (!raw) return;
    const first = typeof words[0]?.start === 'number' ? words[0].start : undefined;
    const last = typeof words[words.length - 1]?.end === 'number' ? words[words.length - 1].end : undefined;
    if (last !== undefined) this.committedEndSec = Math.max(this.committedEndSec, last);
    this.pendingPartial = '';
    // A commit comes after vad_silence of quiet, so the audio the speaker
    // spent silent runs on past the last word. Capped, as the evaluation that
    // tuned the chunker on these commits capped it (evals/scribe-realtime.ts).
    const audioEndSec = last !== undefined ? Math.max(last, Math.min(this.sentSec, last + 1.5)) : undefined;
    this.previousText = (this.previousText + raw).slice(-200);
    const text = this.transform(raw);
    this.drained?.push(text);
    this.onTranscript({
      text,
      isFinal: true,
      timestamp: Date.now(),
      audioStartSec: first,
      audioEndSec,
      firstWordSec: first,
      lastWordEndSec: last,
      speechFinal: true,
    });
    this.commitWaiter?.();
  }

  sendAudio(pcm: Buffer): void {
    if (this.gaveUp) return;
    if (this.started && this.ws?.readyState === WebSocket.OPEN) {
      this.forward(pcm, this.shouldForceCommit(pcm));
    } else if (this.running) {
      this.held.push(pcm);
      this.trimHeld();
    }
  }

  /** See the long-commit cap above. */
  private shouldForceCommit(pcm: Buffer): boolean {
    if (this.maxCommitSec <= 0) return false;
    const rms = ScribeSTT.rms(pcm);
    if (rms > this.speechRms * 0.5) this.speechRms = this.speechRms === 0 ? rms : this.speechRms * 0.95 + rms * 0.05;
    if (!this.pendingPartial.trim()) return false;
    const span = this.sentSec - Math.max(this.committedEndSec, this.forcedAtSec);
    if (span < this.maxCommitSec) return false;
    if (rms >= this.speechRms * 0.3 && span < this.hardCommitSec) return false;
    this.forcedAtSec = this.sentSec;
    console.log(`[STT] Scribe: ${span.toFixed(1)}s without a commit; committing at a pause`);
    return true;
  }

  private static rms(pcm: Buffer): number {
    const n = Math.floor(pcm.length / 2);
    if (n === 0) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = pcm.readInt16LE(i * 2);
      sum += v * v;
    }
    return Math.sqrt(sum / n);
  }

  private forward(pcm: Buffer, commit = false): void {
    const msg: Record<string, unknown> = {
      message_type: 'input_audio_chunk',
      audio_base_64: pcm.toString('base64'),
      commit,
      sample_rate: 16_000,
    };
    // Context from before a reconnect, so the new session does not start cold.
    if (this.firstChunk && this.previousText) msg.previous_text = this.previousText;
    this.firstChunk = false;
    this.lastAudioSentAt = Date.now();
    this.ws!.send(JSON.stringify(msg));
    this.sentLog.push({ pcm, startSec: this.sentSec });
    this.sentSec += pcm.length / ScribeSTT.BYTES_PER_SEC;
    while (this.sentLog.length > 1) {
      const f = this.sentLog[0];
      const end = f.startSec + f.pcm.length / ScribeSTT.BYTES_PER_SEC;
      if (this.sentSec - end <= ScribeSTT.CONTINUITY_MAX_SEC) break;
      this.sentLog.shift();
    }
  }

  /** The socket died: queue what Scribe heard but never committed. */
  private holdUncommitted(): void {
    const from = this.committedEndSec;
    const replay: Buffer[] = [];
    for (const { pcm, startSec } of this.sentLog) {
      const end = startSec + pcm.length / ScribeSTT.BYTES_PER_SEC;
      if (end <= from) continue;
      if (startSec >= from) replay.push(pcm);
      else replay.push(pcm.subarray(Math.round(((from - startSec) * ScribeSTT.BYTES_PER_SEC) / 2) * 2));
    }
    this.sentLog = [];
    this.sentSec = 0;
    this.held = [...replay, ...this.held];
    this.trimHeld();
  }

  private flushHeld(): void {
    if (this.held.length === 0) return;
    const held = this.held;
    this.held = [];
    const sec = held.reduce((n, b) => n + b.length, 0) / ScribeSTT.BYTES_PER_SEC;
    for (const pcm of held) this.forward(pcm);
    console.log(`[STT] sent ${sec.toFixed(1)}s of audio held while Scribe was not connected`);
  }

  private trimHeld(): void {
    const max = ScribeSTT.CONTINUITY_MAX_SEC * ScribeSTT.BYTES_PER_SEC;
    let total = this.held.reduce((n, b) => n + b.length, 0);
    while (total > max && this.held.length > 0) total -= this.held.shift()!.length;
  }

  private giveUp(reason: string): void {
    if (this.gaveUp) return;
    this.gaveUp = true;
    console.error(`[STT] ${reason}; giving up on Scribe for this broadcast`);
    const held = this.held;
    this.disconnect();
    // Hand back what was never transcribed, so a fallback recognizer can hear it.
    this.unsentAudio = held;
    this.onUnavailable?.(reason);
  }

  /** Audio held at give-up time, for a fallback recognizer. */
  unsentAudio: Buffer[] = [];

  private commitWaiter: (() => void) | null = null;
  private drained: string[] | null = null;

  /**
   * Commit whatever the speaker was still saying, return the finals that
   * produced, and disconnect. Without this the benediction at the end of a
   * service was lost (see DeepgramSTT.finish). Bounded for a live operator.
   */
  async finish(timeoutMs = 2000): Promise<string[]> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.started) {
      this.disconnect();
      return [];
    }
    this.drained = [];
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.commitWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
      try {
        // 100 ms of silence carrying the commit flag.
        this.forward(Buffer.alloc(3200), true);
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
    const out = this.drained;
    this.drained = null;
    this.commitWaiter = null;
    this.disconnect();
    return out;
  }

  disconnect(): void {
    const wasRunning = this.running;
    this.running = false;
    this.started = false;
    this.stopWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.held = [];
    this.sentLog = [];
    this.sentSec = 0;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
    if (wasRunning) {
      this.onStatusChange(false);
      console.log('[STT] Scribe stopped');
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.lastPongAt = Date.now();
    this.lastMessageAt = Date.now();
    this.watchdogTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.ping();
      } catch {}
      const now = Date.now();
      // Both clocks quiet: the TCP path is gone without a close event.
      if (now - this.lastPongAt > ScribeSTT.PONG_TIMEOUT_MS && now - this.lastMessageAt > ScribeSTT.PONG_TIMEOUT_MS) {
        console.warn('[STT] Scribe watchdog: no pong and no data, forcing reconnect');
        ws.terminate();
        return;
      }
      if (now - this.lastAudioSentAt < 10_000 && now - this.lastMessageAt > ScribeSTT.SILENT_LINK_TIMEOUT_MS) {
        console.warn('[STT] Scribe watchdog: audio flowing but no messages, forcing reconnect');
        ws.terminate();
      }
    }, ScribeSTT.PING_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    console.log('[STT] Reconnecting to Scribe in 2s...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.openConnection();
    }, 2000);
  }
}
