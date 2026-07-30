/**
 * Handles an incoming broadcaster WebSocket connection.
 *
 * Message types from client:
 *   { type: "start", mode: "fast" | "smooth", direction?: "ko-en" | "en-ko" }
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
import { isStartAuthorized } from './auth';
import { detectReference, mergeReference, formatReference, ScriptureRef } from './scripture';
import { detectReferenceEn } from './scripture-en';
import { OrderedEmitter } from './ordered-emitter';
import { TtsPipeline } from './tts-pipeline';
import {
  Direction,
  getDirectionConfig,
  normalizeDirection,
  resolveTtsModelId,
  resolveTtsVoiceId,
} from './direction-config';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function handleBroadcasterConnection(ws: WebSocket, session: Session): void {
  console.log(`[Broadcaster] New connection (room "${session.roomId}")`);
  session.addBroadcaster(ws);

  let stt: ElevenLabsSTT | null = null;
  let chunker: KoreanChunker | null = null;
  // Translator and scripture detector are per-direction; rebuilt on each
  // start (a fresh translator also resets the discourse context).
  let translator = new ClaudeTranslator(ANTHROPIC_API_KEY);
  let detectRef: (text: string) => ScriptureRef | null = detectReference;

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
    chunkerWaitMs: number;
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

    session.broadcast({
      type: 'translation',
      seq: chunk.seq,
      direct: job.direct,
      sermon: job.sermon,
      timestamp: job.chunkStart,
    });

    enqueueTTS(chunk.seq, job.sermon, job.korean.length, job.chunkerWaitMs, job.translationLatencyMs, job.chunkStart);
  }

  // ── Per-session latency accumulator (averaged + logged on stop) ───────────
  interface StageSample { wait: number; translate: number; firstByte: number; stream: number; e2e: number }
  let latencySamples: StageSample[] = [];

  function logLatencyReport(): void {
    const n = latencySamples.length;
    if (n === 0) return;
    const avg = (k: keyof StageSample) => Math.round(latencySamples.reduce((s, x) => s + x[k], 0) / n);
    console.log(
      `[Latency] session avg over ${n} chunks (${session.direction}): ` +
        `stt→dispatch ${avg('wait')}ms · translate ${avg('translate')}ms · ` +
        `→first-audio-byte ${avg('firstByte')}ms · audio-stream ${avg('stream')}ms · e2e ${avg('e2e')}ms`,
    );
  }

  // Voice + model come from the direction config; rebuilt on each start so a
  // direction change takes effect. Startup validation guarantees the English
  // voice env var exists, so the ko-en default here can never be ''.
  function createTts(direction: Direction): ElevenLabsTTS {
    return new ElevenLabsTTS({
      apiKey: ELEVENLABS_API_KEY,
      voiceId: resolveTtsVoiceId(direction) ?? '',
      modelId: resolveTtsModelId(direction),
    });
  }
  let tts = createTts('ko-en');

  // ── Pipeline: Korean text → Claude → broadcast text → TTS (background) ───
  // `seq` is the spoken-order sequence number, assigned by the chunker at
  // dispatch time. The chunker may run up to 2 translations concurrently
  // during a backlog; finishSeq() re-orders completions so emission (text +
  // TTS + playback) is always in spoken order.
  async function processChunk(sourceText: string, seq: number, waitMs = 0): Promise<void> {
    const chunkStart = Date.now();
    session.metrics.lastChunkSize = sourceText.length;
    session.metrics.chunkerWaitMs = waitMs;

    // Entry runs in dispatch (spoken) order even with parallelism — the
    // chunker starts jobs sequentially — so both the emitter anchor and the
    // reference tracking below stay in spoken order.
    emitter.anchor(seq);

    // Track the Bible reference the pastor announced; expire it after a while
    // so old references don't wrongly anchor later commentary.
    const detected = detectRef(sourceText);
    if (detected) {
      currentRef = mergeReference(currentRef, detected);
      refAgeChunks = 0;
    } else if (currentRef && ++refAgeChunks > 12) {
      currentRef = null;
    }
    const refName = formatReference(currentRef);
    console.log(`[Pipeline] Translating seq ${seq} (${sourceText.length} chars${refName ? `, ref: ${refName}` : ''})...`);

    // Translate (the only blocking step), then park the result for in-order
    // emission. Failures park a skip marker so the emitter never stalls.
    let translation;
    try {
      translation = await translator.translate(sourceText, currentRef);
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
      korean: sourceText, // field name is historical: the SOURCE transcript
      direct: translation.direct_translation,
      sermon: translation.sermon_translation,
      chunkStart,
      chunkerWaitMs: waitMs,
      translationLatencyMs,
    });
  }

  // ── Pipelined streaming-TTS worker ────────────────────────────────────────
  // Translations arrive in spoken order. Up to `prefetch` clips synthesise
  // concurrently (so the next clip's first-byte wait overlaps the current
  // clip's stream — the source of the silent gaps between sentences), but the
  // TtsPipeline forwards audio strictly in enqueue order, which is what the
  // listener's MediaSource playback needs. prefetch stays at 2 to fit
  // ElevenLabs' lowest concurrency limit.
  interface TtsJob {
    seq: number;
    text: string;
    chunkSize: number;
    chunkerWaitMs: number;
    translationLatencyMs: number;
    chunkStart: number;
    enqueuedAt: number;
  }

  // Gap attribution: when the pipeline drains, the listener is about to run out
  // of audio; whatever time passes until the next clip arrives is upstream
  // latency (chunker hold + translation), heard as silence. Log it so live
  // tests show exactly which stage each pause comes from.
  let audioStarvedSince = Date.now();

  const ttsPipeline = new TtsPipeline<TtsJob>({
    prefetch: 2,
    synth: (text, onChunk) => tts.synthesiseStream(text, onChunk),
    onStart: (job) => session.broadcast({ type: 'audio_start', seq: job.seq }),
    onChunk: (job, chunk) =>
      session.broadcast({ type: 'audio_chunk', seq: job.seq, data: chunk.toString('base64') }),
    onEnd: (job, stats) => {
      // Stage (c): translation done → first audio byte (includes queue wait);
      // stage (d): first byte → last byte of the streamed clip.
      const ttsFirstByteMs = stats.firstByteAt ? stats.firstByteAt - job.enqueuedAt : -1;
      const streamMs = stats.firstByteAt ? Date.now() - stats.firstByteAt : 0;
      session.metrics.ttsLatencyMs = stats.ttsLatencyMs;
      session.metrics.ttsFirstByteMs = Math.max(0, ttsFirstByteMs);
      session.metrics.e2eLatencyMs = Date.now() - job.chunkStart;
      latencySamples.push({
        wait: job.chunkerWaitMs,
        translate: job.translationLatencyMs,
        firstByte: Math.max(0, ttsFirstByteMs),
        stream: streamMs,
        e2e: session.metrics.e2eLatencyMs,
      });
      session.broadcast({ type: 'audio_end', seq: job.seq });
      send(ws, {
        type: 'debug',
        chunkSize: job.chunkSize,
        chunkerWaitMs: job.chunkerWaitMs,
        translationLatencyMs: job.translationLatencyMs,
        ttsFirstByteMs: Math.max(0, ttsFirstByteMs),
        ttsLatencyMs: stats.ttsLatencyMs,
        e2eLatencyMs: session.metrics.e2eLatencyMs,
        sttConnected: session.metrics.sttConnected,
      });
      console.log(
        `[Pipeline] seq ${job.seq} stages: wait ${job.chunkerWaitMs}ms · translate ${job.translationLatencyMs}ms · ` +
          `first-byte ${ttsFirstByteMs}ms · stream ${streamMs}ms · e2e ${session.metrics.e2eLatencyMs}ms`,
      );
      if (ttsPipeline.depth === 0) audioStarvedSince = Date.now();
    },
    onError: (job, err) => {
      console.error(`[Pipeline] TTS stream failed (seq ${job.seq}):`, err);
      send(ws, { type: 'error', message: 'TTS generation failed' });
    },
  });

  function enqueueTTS(seq: number, text: string, chunkSize: number, chunkerWaitMs: number, translationLatencyMs: number, chunkStart: number): void {
    if (ttsPipeline.depth === 0 && audioStarvedSince) {
      const starvedMs = Date.now() - audioStarvedSince;
      if (starvedMs > 500) {
        console.log(
          `[Gap] audio starved ~${starvedMs}ms before seq ${seq} ` +
            `(chunker hold ${chunkerWaitMs}ms, translation ${translationLatencyMs}ms; rest = speaker pause)`,
        );
      }
    }
    ttsPipeline.enqueue({ seq, text, chunkSize, chunkerWaitMs, translationLatencyMs, chunkStart, enqueuedAt: Date.now() });
  }

  // A start within this window of the last stop is a RESUME (network blip +
  // auto-restart), not a new sermon — keep the transcript. Beyond it, treat
  // the start as a fresh sermon and begin with a clean transcript.
  const RESUME_WINDOW_MS = 5 * 60 * 1000;

  // ── Start broadcast session ────────────────────────────────────────────────
  function startSession(mode: 'fast' | 'smooth', direction: Direction): void {
    const cfg = getDirectionConfig(direction);
    if (!cfg.implemented) {
      throw new Error(`Translation direction "${direction}" is not implemented yet.`);
    }
    if (!resolveTtsVoiceId(direction)) {
      throw new Error(`No TTS voice configured for direction "${direction}".`);
    }
    if (session.isActive) stopSession();

    const isResume =
      session.lastStoppedAt !== 0 && Date.now() - session.lastStoppedAt < RESUME_WINDOW_MS;
    if (!isResume) {
      session.clearTranscript();
      // Connected listeners' screens reset too — history is authoritative.
      session.broadcast({ type: 'transcript_history', chunks: [] });
    }

    session.isActive = true;
    session.mode = mode;
    session.direction = direction;
    tts = createTts(direction);
    translator = new ClaudeTranslator(ANTHROPIC_API_KEY, undefined, direction);
    detectRef = direction === 'en-ko' ? detectReferenceEn : detectReference;
    currentRef = null;
    refAgeChunks = 0;
    emitter.reset();
    latencySamples = [];

    // Broadcast status to this room's listeners (direction tells them what
    // language they are about to hear).
    session.broadcast({ type: 'status', active: true, direction });

    // Set up chunker. seq is allocated here, at dispatch time, in spoken order.
    chunker = new KoreanChunker({
      mode,
      direction,
      onChunk: processChunk,
      nextSeq: () => session.nextSeq(),
    });

    // Set up streaming STT in the direction's input language
    stt = new ElevenLabsSTT({
      apiKey: ELEVENLABS_API_KEY,
      language: cfg.sttLanguage,
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
    console.log(`[Broadcaster] Session started, mode = ${mode}, direction = ${direction}`);
  }

  function stopSession(): void {
    session.isActive = false;
    session.lastStoppedAt = Date.now();
    const c = chunker;
    chunker = null;
    if (c) {
      // Drain queued + in-flight translations before teardown. Destroying
      // immediately used to clear the pending queue and silently drop the
      // final chunk(s) whenever two translations were still in flight.
      c.forceFlush()
        .catch(() => {})
        .finally(() => c.destroy());
    }
    stt?.disconnect();
    stt = null;

    session.broadcast({ type: 'status', active: false, direction: session.direction });
    logLatencyReport();
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
        case 'start': {
          // Phase A auth: with AUTH_USERS configured, starting a broadcast
          // requires a valid session token from POST /login. Listeners are
          // never gated; open mode (no auth env) allows everything.
          const auth = isStartAuthorized(msg.token);
          if (!auth.ok) {
            console.warn(`[Broadcaster] Rejected start for room "${session.roomId}": ${auth.reason}`);
            send(ws, { type: 'error', message: auth.reason });
            ws.close(4003, 'Unauthorized');
            break;
          }
          if (auth.username) {
            console.log(`[Broadcaster] Start authorized for "${auth.username}" in room "${session.roomId}"`);
          }
          const direction = normalizeDirection(msg.direction);
          try {
            startSession(msg.mode === 'smooth' ? 'smooth' : 'fast', direction);
          } catch (err) {
            const message = (err as Error).message;
            console.warn(`[Broadcaster] Start refused for room "${session.roomId}": ${message}`);
            send(ws, { type: 'error', message });
            break;
          }
          send(ws, { type: 'started', mode: session.mode, direction: session.direction });
          break;
        }

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
    console.log(`[Broadcaster] Disconnected (room "${session.roomId}")`);
    stopSession();
    session.removeBroadcaster(ws);
  });

  ws.on('error', (err) => {
    console.error('[Broadcaster] WS error:', err.message);
  });
}
