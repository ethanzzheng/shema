/**
 * Handles an incoming broadcaster WebSocket connection.
 *
 * Message types from client:
 *   { type: "start", mode: "fast" | "smooth" }
 *   Binary frames → raw PCM 16-bit 16kHz mono audio
 *   { type: "stop" }
 *   { type: "ping" }
 *
 * Message types to client:
 *   { type: "pong" }
 *   { type: "transcript", korean, isFinal, timestamp }
 *   { type: "translation", direct, sermon, seq, timestamp }
 *   { type: "debug", ...metrics }
 *   { type: "error", message }
 *   { type: "status", sttConnected }
 */

import { WebSocket } from 'ws';
import { Session } from './session';
import { ElevenLabsSTT } from './stt';
import { KoreanChunker } from './chunker';
import { ClaudeTranslator } from './translation';
import { ElevenLabsTTS } from './tts';
import { broadcastToListeners } from './listener';
import { detectReference, mergeReference, formatReference, ScriptureRef } from './scripture';
import { OrderedEmitter } from './ordered-emitter';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function handleBroadcasterConnection(ws: WebSocket, session: Session): void {
  console.log('[Broadcaster] New connection');

  let stt: ElevenLabsSTT | null = null;
  let chunker: KoreanChunker | null = null;
  const translator = new ClaudeTranslator(ANTHROPIC_API_KEY);

  // Running Bible reference the pastor is reading from (anchors scripture to NIV).
  let currentRef: ScriptureRef | null = null;
  let refAgeChunks = 0;

  // ── Ordered emitter ────────────────────────────────────────────────────────
  // Translations may complete out of order (the chunker allows a bounded number
  // in flight during backlogs). Completions are parked and emitted — text
  // broadcast + TTS enqueue — strictly in seq (spoken) order.
  interface EmitJob {
    seq: number;
    korean: string;
    direct: string;
    sermon: string;
    chunkStart: number;
    translationLatencyMs: number;
  }
  const emitter = new OrderedEmitter<EmitJob>(emitTranslation);

  function emitTranslation(job: EmitJob): void {
    const chunk = session.addTranslation({
      seq: job.seq,
      korean: job.korean,
      direct: job.direct,
      sermon: job.sermon,
      timestamp: job.chunkStart,
    });

    send(ws, {
      type: 'translation',
      seq: chunk.seq,
      korean: job.korean,
      direct: job.direct,
      sermon: job.sermon,
      timestamp: job.chunkStart,
    });

    broadcastToListeners({
      type: 'translation',
      seq: chunk.seq,
      direct: job.direct,
      sermon: job.sermon,
      timestamp: job.chunkStart,
    });

    enqueueTTS(chunk.seq, job.sermon, job.korean.length, job.translationLatencyMs, job.chunkStart);
  }
  const tts = new ElevenLabsTTS({
    apiKey: ELEVENLABS_API_KEY,
    voiceId: ELEVENLABS_VOICE_ID,
  });

  // ── Pipeline: Korean text → Claude → broadcast text → TTS (background) ───
  // `seq` is the spoken-order sequence number, assigned by the chunker at
  // dispatch time. The chunker may run up to 2 translations concurrently
  // during a backlog; finishSeq() re-orders completions so emission (text +
  // TTS + playback) is always in spoken order.
  async function processChunk(koreanText: string, seq: number): Promise<void> {
    const chunkStart = Date.now();
    session.metrics.lastChunkSize = koreanText.length;

    // Entry runs in dispatch (spoken) order even with parallelism — the
    // chunker starts jobs sequentially — so both the emitter anchor and the
    // reference tracking below stay in spoken order.
    emitter.anchor(seq);

    // Track the Bible reference the pastor announced; expire it after a while
    // so old references don't wrongly anchor later commentary.
    const detected = detectReference(koreanText);
    if (detected) {
      currentRef = mergeReference(currentRef, detected);
      refAgeChunks = 0;
    } else if (currentRef && ++refAgeChunks > 12) {
      currentRef = null;
    }
    const refName = formatReference(currentRef);
    console.log(`[Pipeline] Translating seq ${seq} (${koreanText.length} chars${refName ? `, ref: ${refName}` : ''})...`);

    // Translate (the only blocking step), then park the result for in-order
    // emission. Failures park a skip marker so the emitter never stalls.
    let translation;
    try {
      translation = await translator.translate(koreanText, currentRef);
    } catch (err) {
      console.error('[Pipeline] Translation failed:', err);
      emitter.finish(seq, null);
      return;
    }

    const translationLatencyMs = Date.now() - chunkStart;
    session.metrics.translationLatencyMs = translationLatencyMs;
    console.log(`[Pipeline] Translation done for seq ${seq} in ${translationLatencyMs}ms`);

    if (translation.sermon_translation === '[Translation error]') {
      console.error('[Pipeline] Translation returned error, skipping');
      emitter.finish(seq, null);
      return;
    }

    emitter.finish(seq, {
      seq,
      korean: koreanText,
      direct: translation.direct_translation,
      sermon: translation.sermon_translation,
      chunkStart,
      translationLatencyMs,
    });
  }

  // ── Serial streaming-TTS worker ──────────────────────────────────────────
  // Translations arrive in spoken order; we synthesise them one at a time and
  // stream each clip's MP3 chunks to listeners as they arrive from ElevenLabs.
  // Serialising here guarantees the forwarded audio stream stays in order,
  // which is what the listener's MediaSource playback needs.
  interface TtsJob { seq: number; text: string; chunkSize: number; translationLatencyMs: number; chunkStart: number; }
  const ttsQueue: TtsJob[] = [];
  let ttsRunning = false;

  function enqueueTTS(seq: number, text: string, chunkSize: number, translationLatencyMs: number, chunkStart: number): void {
    ttsQueue.push({ seq, text, chunkSize, translationLatencyMs, chunkStart });
    void pumpTTS();
  }

  async function pumpTTS(): Promise<void> {
    if (ttsRunning) return;
    ttsRunning = true;
    try {
      while (ttsQueue.length > 0) {
        const job = ttsQueue.shift()!;
        await streamTTS(job);
      }
    } finally {
      ttsRunning = false;
    }
  }

  async function streamTTS(job: TtsJob): Promise<void> {
    const { seq, text, chunkSize, translationLatencyMs, chunkStart } = job;
    const ttsStart = Date.now();
    let firstChunkAt = 0;

    broadcastToListeners({ type: 'audio_start', seq });
    try {
      await tts.synthesiseStream(text, (chunk) => {
        if (!firstChunkAt) firstChunkAt = Date.now();
        broadcastToListeners({ type: 'audio_chunk', seq, data: chunk.toString('base64') });
      });
    } catch (err) {
      console.error('[Pipeline] TTS stream failed:', err);
      send(ws, { type: 'error', message: 'TTS generation failed' });
    }
    broadcastToListeners({ type: 'audio_end', seq });

    const ttsLatencyMs = Date.now() - ttsStart;
    session.metrics.ttsLatencyMs = ttsLatencyMs;
    session.metrics.e2eLatencyMs = Date.now() - chunkStart;
    send(ws, {
      type: 'debug',
      chunkSize,
      translationLatencyMs,
      ttsLatencyMs,
      e2eLatencyMs: session.metrics.e2eLatencyMs,
      sttConnected: session.metrics.sttConnected,
    });
    const ttfb = firstChunkAt ? firstChunkAt - ttsStart : -1;
    console.log(`[Pipeline] TTS streamed seq ${seq} (first byte ${ttfb}ms, total ${ttsLatencyMs}ms, ${session.metrics.e2eLatencyMs}ms e2e)`);
  }

  // ── Start broadcast session ────────────────────────────────────────────────
  function startSession(mode: 'fast' | 'smooth'): void {
    if (session.isActive) stopSession();

    session.isActive = true;
    session.mode = mode;
    translator.resetContext();
    currentRef = null;
    refAgeChunks = 0;
    emitter.reset();

    // Broadcast status to listeners
    broadcastToListeners({ type: 'status', active: true });

    // Set up chunker. seq is allocated here, at dispatch time, in spoken order.
    chunker = new KoreanChunker({
      mode,
      onChunk: processChunk,
      nextSeq: () => session.nextSeq(),
    });

    // Set up ElevenLabs STT
    stt = new ElevenLabsSTT({
      apiKey: ELEVENLABS_API_KEY,
      onTranscript: async ({ text, isFinal, timestamp }) => {
        console.log(`[Broadcaster] STT transcript (final=${isFinal}): "${text.slice(0, 60)}…"`);
        // Send live Korean transcript to broadcaster UI
        send(ws, { type: 'transcript', korean: text, isFinal, timestamp });

        // Feed into chunker
        if (chunker) await chunker.feed(text, isFinal);
      },
      onError: (err) => {
        send(ws, { type: 'error', message: `STT error: ${err.message}` });
      },
      onStatusChange: (connected) => {
        session.metrics.sttConnected = connected;
        send(ws, { type: 'status', sttConnected: connected });
      },
    });

    stt.connect();
    console.log('[Broadcaster] Session started, mode =', mode);
  }

  function stopSession(): void {
    session.isActive = false;
    chunker?.forceFlush().catch(() => {});
    chunker?.destroy();
    chunker = null;
    stt?.disconnect();
    stt = null;

    broadcastToListeners({ type: 'status', active: false });
    console.log('[Broadcaster] Session stopped');
  }

  // ── WebSocket message handlers ─────────────────────────────────────────────
  let audioChunkCount = 0;
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Raw PCM audio from broadcaster
      audioChunkCount++;
      if (audioChunkCount % 50 === 1) {
        console.log(`[Broadcaster] Audio chunk #${audioChunkCount}, ${(data as Buffer).byteLength} bytes, stt=${!!stt}, active=${session.isActive}`);
      }
      if (stt && session.isActive) {
        stt.sendAudio(data as Buffer);
      }
      return;
    }

    try {
      const msg = JSON.parse((data as Buffer).toString());

      switch (msg.type) {
        case 'start':
          startSession(msg.mode === 'smooth' ? 'smooth' : 'fast');
          send(ws, { type: 'started', mode: session.mode });
          break;

        case 'stop':
          stopSession();
          send(ws, { type: 'stopped' });
          break;

        case 'mode':
          session.mode = msg.mode === 'smooth' ? 'smooth' : 'fast';
          chunker?.setMode(session.mode);
          break;

        case 'ping':
          send(ws, { type: 'pong' });
          break;

        default:
          console.warn('[Broadcaster] Unknown message type:', msg.type);
      }
    } catch (err) {
      console.error('[Broadcaster] Parse error:', err);
    }
  });

  ws.on('close', () => {
    console.log('[Broadcaster] Disconnected');
    stopSession();
  });

  ws.on('error', (err) => {
    console.error('[Broadcaster] WS error:', err.message);
  });
}
