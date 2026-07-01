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

export interface TranscriptEvent {
  text: string;
  isFinal: boolean;
  timestamp: number;
}

export class ElevenLabsSTT {
  // Keep class name for backward compatibility with broadcaster.ts
  private apiKey: string;
  private onTranscript: (event: TranscriptEvent) => void;
  private onError: (err: Error) => void;
  private onStatusChange: (connected: boolean) => void;

  private ws: WebSocket | null = null;
  private running = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;

  // Buffer final (non-speech_final) results to build up utterances
  private utteranceBuffer = '';
  private lastEmitAt = 0;
  // Track recent utterances to prevent exact duplicates only
  private recentUtterances: string[] = [];

  constructor(opts: {
    apiKey: string;
    flushIntervalMs?: number; // unused, kept for interface compat
    onTranscript: (event: TranscriptEvent) => void;
    onError: (err: Error) => void;
    onStatusChange: (connected: boolean) => void;
  }) {
    this.apiKey = process.env.DEEPGRAM_API_KEY || opts.apiKey;
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
      language: 'ko',
      punctuate: 'true',
      interim_results: 'true',
      endpointing: '400',        // 400ms silence = end of utterance (was 800ms)
      utterance_end_ms: '1200',  // also emit if utterance exceeds 1.2s of audio
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      smart_format: 'true',
    });

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Token ${this.apiKey}`,
      },
    });

    this.ws.on('open', () => {
      console.log('[STT] Deepgram WebSocket connected');
      this.onStatusChange(true);
      this.startKeepAlive();
    });

    let msgCount = 0;
    this.ws.on('message', (data: WebSocket.Data) => {
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
    const speechFinal = msg.speech_final === true;

    if (!transcript) return;

    if (isFinal) {
      // Accumulate final segments into the utterance buffer
      this.utteranceBuffer += (this.utteranceBuffer ? ' ' : '') + transcript;

      const bufLen = this.utteranceBuffer.trim().length;
      const timeSinceEmit = Date.now() - this.lastEmitAt;

      if (speechFinal) {
        // Natural pause detected by Deepgram — emit immediately
        this.emitBuffer();
      } else if (bufLen >= 25 && timeSinceEmit >= 1500) {
        // 25 Korean chars ≈ 8–12 spoken words ≈ 4–6 seconds of speech
        // (Korean is ~3x more compact than English per char)
        console.log(`[STT] Proactive emit: ${bufLen} chars, ${timeSinceEmit}ms since last emit`);
        this.emitBuffer();
      } else {
        // Fallback flush — never wait more than 1.5s
        this.resetFlushTimer();
      }
    }
  }

  /** Emit the utterance buffer if it has content */
  private emitBuffer(): void {
    this.cancelFlushTimer();
    const fullUtterance = this.utteranceBuffer.trim();
    this.utteranceBuffer = '';

    this.lastEmitAt = Date.now();

    if (fullUtterance && !this.isDuplicate(fullUtterance)) {
      this.recentUtterances.push(fullUtterance);
      if (this.recentUtterances.length > 5) this.recentUtterances.shift();

      console.log(`[STT] Utterance: "${fullUtterance.slice(0, 100)}${fullUtterance.length > 100 ? '…' : ''}"`);
      this.onTranscript({
        text: fullUtterance,
        isFinal: true,
        timestamp: Date.now(),
      });
    }
  }

  /** Force emit after 2.5s even if speaker hasn't paused (was 5s) */
  private flushTimer: NodeJS.Timeout | null = null;

  private resetFlushTimer(): void {
    this.cancelFlushTimer();
    this.flushTimer = setTimeout(() => {
      if (this.utteranceBuffer.trim()) {
        console.log('[STT] Flush timer triggered (no speech_final for 1.5s)');
        this.emitBuffer();
      }
    }, 1500);
  }

  private cancelFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
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
      this.ws.send(pcm);
    }
  }

  disconnect(): void {
    this.running = false;
    this.stopKeepAlive();
    this.cancelFlushTimer();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Emit any remaining utterance
    this.emitBuffer();

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

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    console.log('[STT] Reconnecting in 2s...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.openConnection();
    }, 2000);
  }
}
