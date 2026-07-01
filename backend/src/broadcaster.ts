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
  const tts = new ElevenLabsTTS({
    apiKey: ELEVENLABS_API_KEY,
    voiceId: ELEVENLABS_VOICE_ID,
  });

  // ── Pipeline: Korean text → Claude → broadcast text → TTS (background) ───
  async function processChunk(koreanText: string): Promise<void> {
    const chunkStart = Date.now();
    session.metrics.lastChunkSize = koreanText.length;
    console.log(`[Pipeline] Translating ${koreanText.length} chars...`);

    // 1. Translate (this is the only blocking step)
    let translation;
    try {
      translation = await translator.translate(koreanText);
    } catch (err) {
      console.error('[Pipeline] Translation failed:', err);
      return;
    }

    const translationLatencyMs = Date.now() - chunkStart;
    session.metrics.translationLatencyMs = translationLatencyMs;
    console.log(`[Pipeline] Translation done in ${translationLatencyMs}ms`);

    // Skip error translations
    if (translation.sermon_translation === '[Translation error]') {
      console.error('[Pipeline] Translation returned error, skipping');
      return;
    }

    const chunk = session.addTranslation({
      korean: koreanText,
      direct: translation.direct_translation,
      sermon: translation.sermon_translation,
      timestamp: chunkStart,
    });

    // 2. Broadcast translation text IMMEDIATELY (don't wait for TTS)
    send(ws, {
      type: 'translation',
      seq: chunk.seq,
      korean: koreanText,
      direct: translation.direct_translation,
      sermon: translation.sermon_translation,
      timestamp: chunkStart,
    });

    broadcastToListeners({
      type: 'translation',
      seq: chunk.seq,
      direct: translation.direct_translation,
      sermon: translation.sermon_translation,
      timestamp: chunkStart,
    });

    // 3. Generate TTS in background — don't block the pipeline
    generateTTS(translation.sermon_translation, chunk.seq, koreanText.length, translationLatencyMs, chunkStart);
  }

  // Fire-and-forget TTS generation
  function generateTTS(sermonText: string, seq: number, chunkSize: number, translationLatencyMs: number, chunkStart: number): void {
    tts.synthesise(sermonText)
      .then((audioBuffer) => {
        const ttsLatencyMs = Date.now() - chunkStart - translationLatencyMs;
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

        broadcastToListeners({
          type: 'audio',
          seq,
          data: audioBuffer.toString('base64'),
          format: 'mp3',
        });

        console.log(`[Pipeline] TTS done for seq ${seq} (${session.metrics.e2eLatencyMs}ms e2e)`);
      })
      .catch((err) => {
        console.error('[Pipeline] TTS failed:', err);
        send(ws, { type: 'error', message: 'TTS generation failed' });
      });
  }

  // ── Start broadcast session ────────────────────────────────────────────────
  function startSession(mode: 'fast' | 'smooth'): void {
    if (session.isActive) stopSession();

    session.isActive = true;
    session.mode = mode;
    translator.resetContext();

    // Broadcast status to listeners
    broadcastToListeners({ type: 'status', active: true });

    // Set up chunker
    chunker = new KoreanChunker({
      mode,
      onChunk: processChunk,
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
