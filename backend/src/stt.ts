/**
 * Deepgram Streaming Speech-to-Text via WebSocket.
 *
 * Maintains a persistent WebSocket to Deepgram's nova-3 model for Korean.
 * Audio is streamed continuously — Deepgram handles endpointing, context,
 * and returns coherent transcripts with is_final/speech_final markers.
 *
 * This replaces the ElevenLabs batch approach which produced fragmented
 * transcripts from isolated audio chunks.
 *
 * Docs: https://developers.deepgram.com/reference/speech-to-text/listen-streaming
 */

import WebSocket from 'ws';

/**
 * Korean biblical / sermon vocabulary fed to Deepgram as keyterms (nova-3
 * keyterm prompting). Biases recognition toward these so names and church
 * terms stop coming out as garbled tokens (e.g. 빌립 → "Gilim"). Override per
 * sermon with the DEEPGRAM_KEYTERMS env var (comma-separated).
 */
const DEFAULT_KEYTERMS = [
  // Names of God / titles
  '예수', '예수님', '하나님', '성령', '그리스도', '예수 그리스도', '주님',
  // Bible figures
  '안드레', '빌립', '베드로', '요한', '바울', '모세', '다윗', '아브라함', '이사야',
  // Core terms
  '복음', '은혜', '믿음', '구원', '기도', '말씀', '제자', '사도', '기적',
  '오병이어', '보리떡', '물고기', '천국', '십자가', '부활', '회개', '축복',
  // 교회 gets misheard as 기회 ("opportunity") in fast speech — bias hard.
  '교회',
  // House-church terms (this congregation) — STT garbles these without biasing.
  // 목자님 (honorific) included separately: it was misheard as 목사님 ("pastor"),
  // which collapses the shepherd/pastor distinction whole stories hang on.
  '목장', '목자', '목자님', '목녀', '한마음교회', '큐티', '성령님', '은사',
];

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  timestamp: number;
}

export class ElevenLabsSTT {
  // Keep class name for backward compatibility with broadcaster.ts
  private apiKey: string;
  private language: string;
  private onTranscript: (event: TranscriptEvent) => void;
  private onError: (err: Error) => void;
  private onStatusChange: (connected: boolean) => void;

  private ws: WebSocket | null = null;
  private running = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;

  // Half-dead-connection watchdog. Flaky networks (hotspots, church Wi-Fi)
  // can kill the TCP path WITHOUT a close event — the socket looks OPEN
  // forever while nothing flows, which stalls transcription until a human
  // restarts the broadcast. We ping at the WS protocol level and force a
  // reconnect when pongs stop coming back.
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private lastMessageAt = 0;
  private lastAudioSentAt = 0;
  private static readonly PING_INTERVAL_MS = 10_000;
  private static readonly PONG_TIMEOUT_MS = 25_000;
  /** Audio flowing but zero Deepgram messages for this long → assume hung. */
  private static readonly SILENT_LINK_TIMEOUT_MS = 60_000;

  // Track recent utterances to prevent exact duplicates only
  private recentUtterances: string[] = [];

  constructor(opts: {
    apiKey: string;
    /** Deepgram language code for the input speech (default 'ko'). */
    language?: string;
    flushIntervalMs?: number; // unused, kept for interface compat
    onTranscript: (event: TranscriptEvent) => void;
    onError: (err: Error) => void;
    onStatusChange: (connected: boolean) => void;
  }) {
    this.apiKey = process.env.DEEPGRAM_API_KEY || opts.apiKey;
    this.language = opts.language ?? 'ko';
    this.onTranscript = opts.onTranscript;
    this.onError = opts.onError;
    this.onStatusChange = opts.onStatusChange;
  }

  get isConnected(): boolean {
    return this.running && this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.running) return;
    this.running = true;
    this.openConnection();
  }

  private openConnection(): void {
    if (!this.running) return;

    // Build Deepgram streaming URL with params
    const params = new URLSearchParams({
      model: 'nova-3',
      language: this.language,
      punctuate: 'true',
      interim_results: 'true',
      endpointing: '400',        // finalize utterances promptly; the chunker reassembles sentences
      utterance_end_ms: '1000',  // also emit if utterance exceeds 1.0s of trailing silence
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      smart_format: 'true',
    });

    // nova-3 keyterm prompting — bias recognition toward sermon/biblical
    // vocabulary so names & terms stop coming out garbled. Repeat per term.
    const keyterms = (process.env.DEEPGRAM_KEYTERMS
      ? process.env.DEEPGRAM_KEYTERMS.split(',')
      : DEFAULT_KEYTERMS
    )
      .map((k) => k.trim())
      .filter(Boolean);
    for (const kt of keyterms) params.append('keyterm', kt);

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    console.log(`[STT] Connecting to Deepgram (nova-3, ${this.language}, ${keyterms.length} keyterms)`);

    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Token ${this.apiKey}`,
      },
    });

    this.ws.on('open', () => {
      console.log('[STT] Deepgram WebSocket connected');
      this.onStatusChange(true);
      this.startKeepAlive();
      this.startWatchdog();
    });

    this.ws.on('pong', () => {
      this.lastPongAt = Date.now();
    });

    let msgCount = 0;
    this.ws.on('message', (data: WebSocket.Data) => {
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(data.toString());
        msgCount++;
        if (msgCount <= 3 || msgCount % 20 === 0) {
          const t = msg.channel?.alternatives?.[0]?.transcript || '';
          console.log(`[STT] Deepgram msg #${msgCount}: type=${msg.type} is_final=${msg.is_final} speech_final=${msg.speech_final} transcript="${t.slice(0, 50)}"`);
        }
        this.handleMessage(msg);
      } catch (err) {
        // Ignore non-JSON messages
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[STT] Deepgram WebSocket closed: ${code} ${reason.toString()}`);
      this.onStatusChange(false);
      this.stopKeepAlive();
      this.stopWatchdog();
      if (this.running) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error('[STT] Deepgram WebSocket error:', err.message);
      this.onError(err);
    });

    console.log('[STT] Started (Deepgram streaming mode)');
  }

  private handleMessage(msg: any): void {
    if (msg.type !== 'Results') return;

    const transcript = msg.channel?.alternatives?.[0]?.transcript || '';
    const isFinal = msg.is_final === true;

    if (!transcript || !isFinal) return;

    // Forward every finalized segment IMMEDIATELY — the chunker owns sentence
    // assembly. This layer used to hold text until it ended on a sentence
    // boundary, but during a rapid ramble Deepgram finalizes mid-clause and
    // new finals kept resetting the flush timer, so completed sentences sat
    // here for 10s+ before the pipeline ever saw them.
    if (this.isDuplicate(transcript)) return;
    this.recentUtterances.push(transcript);
    if (this.recentUtterances.length > 5) this.recentUtterances.shift();

    this.onTranscript({ text: transcript, isFinal: true, timestamp: Date.now() });
  }

  private isDuplicate(text: string): boolean {
    for (const recent of this.recentUtterances) {
      // Only block exact matches — anything else is new speech worth translating
      if (recent === text) return true;
    }
    return false;
  }

  sendAudio(pcm: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.lastAudioSentAt = Date.now();
      this.ws.send(pcm);
    }
  }

  disconnect(): void {
    this.running = false;
    this.stopKeepAlive();
    this.stopWatchdog();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.recentUtterances = [];

    if (this.ws) {
      // Send CloseStream message for clean shutdown
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {}
      this.ws.close();
      this.ws = null;
    }

    this.onStatusChange(false);
    console.log('[STT] Stopped');
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    // Send keepalive every 8s to prevent timeout
    this.keepAliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 8000);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    const now = Date.now();
    this.lastPongAt = now;
    this.lastMessageAt = now;
    this.watchdogTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // Protocol-level liveness: ping, and reconnect when pongs stop.
      try { ws.ping(); } catch {}
      const sincePong = Date.now() - this.lastPongAt;
      if (sincePong > ElevenLabsSTT.PONG_TIMEOUT_MS) {
        console.warn(`[STT] Watchdog: no pong for ${Math.round(sincePong / 1000)}s — connection is half-dead, forcing reconnect`);
        ws.terminate(); // emits 'close' → scheduleReconnect
        return;
      }

      // App-level backstop: audio is flowing out but Deepgram has said
      // nothing at all for a long time — treat the session as hung. (A
      // reconnect during genuine dead silence costs ~2s of nothing.)
      const audioFresh = Date.now() - this.lastAudioSentAt < 10_000;
      const sinceMsg = Date.now() - this.lastMessageAt;
      if (audioFresh && sinceMsg > ElevenLabsSTT.SILENT_LINK_TIMEOUT_MS) {
        console.warn(`[STT] Watchdog: audio flowing but no Deepgram messages for ${Math.round(sinceMsg / 1000)}s — forcing reconnect`);
        ws.terminate();
      }
    }, ElevenLabsSTT.PING_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    console.log('[STT] Reconnecting in 2s...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.openConnection();
    }, 2000);
  }
}
