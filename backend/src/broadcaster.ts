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
import { DeepgramSTT, DEFAULT_KEYTERMS as DEFAULT_STT_KEYTERMS, DEFAULT_KEYTERMS_ZH } from './stt';
import { randomUUID } from 'crypto';
import { loadChurchGlossary, loadSessionTerms } from './glossary/load';
import { budgetKeyterms } from './glossary/merge';
import { TranscriptWriter } from './transcripts/writer';
import { ANON_LEDGER_KEY, mayUseAnonTts, mayUseTts, recordTtsSpend } from './demo/budget';
import { recordEvent } from './demo/events';
import { KoreanChunker } from './chunker';
import { isPureRestart } from './text';
import { ClaudeTranslator } from './translation';
import { ElevenLabsTTS } from './tts';
import { allowedDirections, isStartAuthorized } from './auth';
import { detectReference, mergeReference, formatReference, detectVerseRange, correctVerseAgainstRange, ScriptureRef } from './scripture';
import { detectReferenceEn } from './scripture-en';
import { detectReferenceZh } from './scripture-zh';
import { keepReadingZh } from './verse-match-zh';
import { OrderedEmitter } from './ordered-emitter';
import { TtsPipeline } from './tts-pipeline';
import {
  Direction,
  getDirectionConfig,
  normalizeDirection,
  resolveTtsModelId,
  resolveTtsVoiceId,
  resolveStt,
} from './direction-config';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY!;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function handleBroadcasterConnection(ws: WebSocket, session: Session): void {
  console.log(`[Broadcaster] New connection (room "${session.roomId}")`);
  session.addBroadcaster(ws);

  let stt: DeepgramSTT | null = null;
  /** Records this broadcast to the database. Null when no database is reachable. */
  let transcript: TranscriptWriter | null = null;
  const recordingTranscript = (): boolean => transcript !== null;
  let chunker: KoreanChunker | null = null;
  // Translator and scripture detector are per-direction; rebuilt on each
  // start (a fresh translator also resets the discourse context).
  let translator = new ClaudeTranslator(ANTHROPIC_API_KEY, undefined, 'ko-en', session.roomId);
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
    // Cross-segment restart guard. The pastor sometimes false-starts and
    // retries a sentence, and each attempt arrives as its own STT final, so
    // the listener heard "Among church members." three times running. This
    // cannot be fixed in the prompt: contextBlock is built before the API
    // call and recentTranslations is appended after it, so two concurrent
    // translations never see each other — exactly the burst case where
    // restarts happen. Here in the OrderedEmitter funnel, emission is
    // strictly sequential and in spoken order, so the comparison is reliable.
    //
    // Deliberately conservative: suppress ONLY a segment that adds nothing to
    // the one before it. Anything carrying new words goes out untouched.
    const prevSermon = session.lastTranslationText();
    if (prevSermon && isPureRestart(prevSermon, job.sermon)) {
      console.log(`[Pipeline] seq ${job.seq} suppressed as a false-start restart: "${job.sermon}"`);
      return;
    }

    const chunk = session.addTranslation({
      seq: job.seq,
      korean: job.korean,
      direct: job.direct,
      sermon: job.sermon,
      timestamp: job.chunkStart,
    });

    // Persist here and nowhere else: this is the one point where a segment's
    // text is final, in spoken order, and past the false-start suppression
    // above — so a sentence the pastor restarted never reaches the record.
    // The call does no I/O; see TranscriptWriter.
    transcript?.add({
      seq: chunk.seq,
      sourceText: job.korean,
      sermon: job.sermon,
      direct: job.direct,
      lang: getDirectionConfig(session.direction).targetLang,
      timestampMs: job.chunkStart,
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
    // Worth seeing per service: a rising count means the voice is drifting
    // quiet on short lines, which is otherwise only audible in the pews.
    if (quietClipsRaised > 0) {
      console.log(
        `[Audio] ${quietClipsRaised} of ${n} clips came back under-driven and were raised`,
      );
    }
  }

  // Speaking rate (drift control): Korean renderings often run longer than
  // the English they translate, so en-ko can take TTS_SPEED_KO (falling back
  // to TTS_SPEED); ko-en uses TTS_SPEED alone.
  function ttsSpeed(direction: Direction): number | undefined {
    const raw =
      direction === 'en-ko'
        ? process.env.TTS_SPEED_KO ?? process.env.TTS_SPEED
        : process.env.TTS_SPEED;
    const v = parseFloat(raw ?? '');
    return Number.isFinite(v) ? v : undefined;
  }

  // Voice + model come from the direction config; rebuilt on each start so a
  // direction change takes effect. Startup validation guarantees the English
  // voice env var exists, so the ko-en default here can never be ''.
  function createTts(direction: Direction): ElevenLabsTTS {
    return new ElevenLabsTTS({
      apiKey: ELEVENLABS_API_KEY,
      voiceId: resolveTtsVoiceId(direction) ?? '',
      modelId: resolveTtsModelId(direction),
      speed: ttsSpeed(direction),
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
    // An announced range ("21절부터 25절까지") scopes the reading; a later verse
    // outside it is checked for the dropped-tens mishearing before use.
    if (session.direction === 'ko-en') {
      const range = detectVerseRange(sourceText);
      if (range) activeRange = range;
    }
    const detected = detectRef(sourceText);
    if (detected) {
      if (detected.verse !== undefined && activeRange) {
        const { verse, corrected } = correctVerseAgainstRange(detected.verse, activeRange);
        if (corrected) {
          console.log(
            `[Scripture] verse ${detected.verse} is outside the announced range ` +
              `${activeRange.start}-${activeRange.end}; corrected to ${verse} (dropped-tens mishearing)`,
          );
          detected.verse = verse;
        }
      }
      currentRef = mergeReference(currentRef, detected);
      refAgeChunks = 0;
    } else if (session.direction === 'zh-en' && keepReadingZh(currentRef, sourceText)) {
      // Still reading the passage: the spoken words match its verses.
      refAgeChunks = 0;
    } else if (currentRef && ++refAgeChunks > 12) {
      currentRef = null;
      activeRange = null;
    }
    const refName = formatReference(currentRef);
    console.log(`[Pipeline] Translating seq ${seq} (${sourceText.length} chars${refName ? `, ref: ${refName}` : ''})...`);

    // Translate (the only blocking step), then park the result for in-order
    // emission. Failures park a skip marker so the emitter never stalls.
    let translation;
    try {
      translation = await translator.translate(sourceText, currentRef, 1, seq);
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
  /**
   * The passage range announced for the current reading. A verse heard outside
   * it is usually a mishearing — 이십오 (25) losing its 이 becomes 십오 (15),
   * which reached a live congregation as "verse 24 and 15".
   */
  let activeRange: { start: number; end: number } | null = null;
  /** Previous sentence sent to TTS, for prosody continuity across clips. */
  let lastSynthText = '';
  /** Clips that came back under-driven and were raised to the normal level. */
  let quietClipsRaised = 0;

  const ttsPipeline = new TtsPipeline<TtsJob>({
    prefetch: 2,
    synth: (text, onChunk) => {
      const prev = lastSynthText;
      lastSynthText = text;
      // Short lines are held and level-checked before release; long ones
      // stream straight through. See synthesiseStreamLevelled.
      return tts.synthesiseStreamLevelled(text, onChunk, 8000, prev, ({ meanGain, steps }) => {
        quietClipsRaised++;
        console.log(
          `[tts] clip came back under-driven (mean gain ${meanGain.toFixed(1)}), raised ${steps} steps: "${text.slice(0, 40)}"`,
        );
      });
    },
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

  /**
   * Demo rooms pay for speech out of a capped budget, so TTS is gated here
   * rather than at the edges: this is the single point every spoken segment
   * passes through, and a check anywhere else could be bypassed by a code
   * path that forgot about it.
   *
   * Anonymous demos never reach ElevenLabs at all — captions are the whole
   * anonymous product. Signed-in demos are checked against the account's
   * allowance and the day's global ceiling before each segment, and the spend
   * is recorded after.
   *
   * Returns true when the segment may be spoken. Church rooms always may.
   */
  async function demoMaySpeak(text: string): Promise<boolean> {
    const demo = session.demo;
    if (!demo) return true; // a real service

    if (!demo.ttsAllowed) return false;

    // An anonymous visitor gets a real taste before the wall. A browser voice
    // undersells the product at the exact moment it is meant to impress, so
    // the opening stretch is the genuine voice and the fallback is what makes
    // signing in worth doing.
    const decision = demo.clerkUserId
      ? await mayUseTts(demo.clerkUserId)
      : await mayUseAnonTts(demo.ttsChars);
    if (!decision.allowed) {
      // Tell the desk once, so the UI can explain itself rather than just
      // going quiet, then drop to captions for the rest of the session.
      demo.ttsAllowed = false;
      send(ws, { type: 'demo_tts_stopped', reason: decision.reason, message: decision.message });
      recordEvent({
        event: 'cap_reached',
        sessionId: session.roomId,
        clerkUserId: demo.clerkUserId,
        meta: { reason: decision.reason },
      });
      console.log(`[Demo] TTS stopped for "${session.roomId}": ${decision.reason}`);
      return false;
    }

    demo.ttsChars += text.length;
    // Anonymous spend is real spend, so it goes on the same ledger and counts
    // against the day's global ceiling.
    void recordTtsSpend(demo.clerkUserId ?? ANON_LEDGER_KEY, text.length);
    return true;
  }

  /** Serialises demo budget checks so TTS stays in spoken order. */
  let demoTtsGate: Promise<void> = Promise.resolve();

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
    const job = { seq, text, chunkSize, chunkerWaitMs, translationLatencyMs, chunkStart, enqueuedAt: Date.now() };

    // A church room enqueues synchronously, exactly as before. The demo path
    // has to await a budget check, and TtsPipeline is a FIFO on ARRIVAL order,
    // not seq — so two checks resolving out of order would speak the sermon
    // out of order. Chaining them keeps the queue in the order the emitter
    // handed segments over.
    if (!session.demo) {
      ttsPipeline.enqueue(job);
      return;
    }
    demoTtsGate = demoTtsGate
      .then(async () => {
        if (await demoMaySpeak(text)) ttsPipeline.enqueue(job);
      })
      .catch(() => {
        /* a failed check already denied; never break the chain */
      });
  }

  // A start within this window of the last stop is a RESUME (network blip +
  // auto-restart), not a new sermon — keep the transcript. Beyond it, treat
  // the start as a fresh sermon and begin with a clean transcript.
  const RESUME_WINDOW_MS = 5 * 60 * 1000;

  // True only for the connection whose `start` owns the current broadcast.
  // Non-owners (zombie tabs, stale reconnects) can neither stop the session
  // nor kill it by disconnecting.
  let ownsSession = false;

  /**
   * Audio that arrives after `start` but before the STT exists. Starting
   * awaits the database (glossary, transcript record) before building the
   * STT, and audio in that window used to be dropped — the first word or two
   * of a service, and of every automatic resume after a network blip.
   * Handed to the STT the moment it is built; it holds its own until
   * Deepgram's socket opens. Bounded like the STT's own hold.
   */
  let preSttAudio: Buffer[] = [];
  const PRE_STT_MAX_BYTES = 20 * 32_000;

  /** Tear down THIS connection's pipeline (STT + chunker), draining first. */
  function teardownPipeline(): void {
    const c = chunker;
    const s = stt;
    chunker = null;
    stt = null;
    preSttAudio = [];
    if (session.direction !== 'zh-en') {
      // Korean and English→Korean: the deployed teardown, unchanged until the
      // last-sentence flush below is tested on those services.
      if (c) {
        // Drain queued + in-flight translations before teardown. Destroying
        // immediately used to clear the pending queue and silently drop the
        // final chunk(s) whenever two translations were still in flight.
        c.forceFlush()
          .catch(() => {})
          .finally(() => c.destroy());
      }
      s?.disconnect();
      return;
    }
    // Ask Deepgram for whatever the pastor was still saying BEFORE draining
    // the chunker, and feed those last finals in by hand: the module-level
    // chunker is already null (so a fresh start can't collide with this
    // teardown), which means the normal onTranscript path would drop them.
    // Then drain queued + in-flight translations — destroying immediately used
    // to clear the pending queue and drop the final chunk(s).
    void (async () => {
      const late = s ? await s.finish().catch(() => [] as string[]) : [];
      if (!c) return;
      for (const text of late) await c.feed(text, true).catch(() => {});
      await c.forceFlush().catch(() => {});
      c.destroy();
    })();
  }

  // ── Start broadcast session ────────────────────────────────────────────────
  async function startSession(mode: 'fast' | 'smooth', direction: Direction): Promise<void> {
    const cfg = getDirectionConfig(direction);
    const sttCfg = resolveStt(direction);
    if (!cfg.implemented) {
      throw new Error(`Translation direction "${direction}" is not implemented yet.`);
    }
    if (!resolveTtsVoiceId(direction)) {
      throw new Error(`No TTS voice configured for direction "${direction}".`);
    }

    // A start while the session is live counts as a resume regardless of
    // which connection ran it (an operator reloading /speak takes over the
    // running broadcast without wiping the congregation's transcript).
    const isResume =
      session.isActive ||
      (session.lastStoppedAt !== 0 && Date.now() - session.lastStoppedAt < RESUME_WINDOW_MS);

    // Take over: tear down whichever connection's pipeline ran the previous
    // broadcast — this one's on a restart, or another tab's on a takeover —
    // WITHOUT ending the session itself.
    if (session.activeBroadcastTeardown) {
      session.activeBroadcastTeardown();
      session.activeBroadcastTeardown = null;
    }
    if (!isResume) {
      session.clearTranscript();
      // Connected listeners' screens reset too — history is authoritative.
      session.broadcast({ type: 'transcript_history', chunks: [] });
    }

    ownsSession = true;
    session.activeBroadcastTeardown = () => {
      teardownPipeline();
      ownsSession = false;
    };
    audioStarvedSince = Date.now(); // gap attribution restarts with the session
    session.isActive = true;
    session.mode = mode;
    session.direction = direction;
    tts = createTts(direction);

    // Load this church's glossary once, here. Nothing downstream reads the
    // database again: the translator renders the church tier into its cached
    // system prompt, and the live tier is served from memory per sentence.
    // A failure falls back to the env vars rather than delaying going on air.
    // A fresh sermon opens a new service scope; a resume keeps the existing one
    // so terms added before the break survive it. Terms staged before going on
    // air also keep their scope — an operator who types a song title during the
    // opening hymn should not lose it the moment they hit Start.
    // Concurrent, not sequential: if the database is unreachable these each
    // wait out a connection timeout, and doing them in turn would double the
    // delay before a service can go on air.
    const targetLang = cfg.targetLang;
    const [staged, loaded] = await Promise.all([
      session.broadcastId ? loadSessionTerms(session.broadcastId) : Promise.resolve([]),
      loadChurchGlossary(session.roomId, targetLang, cfg.sourceLang),
    ]);
    if (!isResume && staged.length === 0) session.broadcastId = randomUUID();
    else session.ensureBroadcastId();
    const live = session.broadcastId === null ? [] : staged;
    session.setGlossary(loaded.terms, live, loaded.source);
    console.log(
      `[Glossary] room "${session.roomId}": ${loaded.terms.length} church term(s) from ${loaded.source}` +
        `, ${live.length} service term(s)` +
        (loaded.source === 'env' ? ' (DATABASE FALLBACK)' : ''),
    );

    // Record the service. Opened alongside the glossary and equally optional:
    // no database, or an unreachable one, costs the transcript and nothing
    // else. Every service is kept; a church removes one afterwards from the
    // transcripts page rather than deciding in the moment.
    //
    // Demos are the exception and keep nothing. A stranger trying the product
    // from a cold email has not consented to their voice being archived, and
    // their sentences would otherwise sit in a church's transcript list.
    transcript = session.demo ? null : await TranscriptWriter.open({
      churchId: session.roomId,
      sessionId: session.broadcastId as string,
      sourceLang: cfg.sourceLang,
      targetLangs: [targetLang],
    });
    if (session.demo) {
      console.log(`[Transcript] Not recording demo room "${session.roomId}" — demos keep nothing`);
    } else {
      console.log(
        transcript
          ? `[Transcript] Recording room "${session.roomId}"`
          : `[Transcript] NOT recording room "${session.roomId}" — no database reachable`,
      );
    }

    translator = new ClaudeTranslator(ANTHROPIC_API_KEY, undefined, direction, session.roomId, {
      churchTerms: loaded.terms,
      // Read per translation, so a term added at the desk mid-sermon is in
      // force for the very next sentence.
      getLiveTerms: () => session.glossaryLive,
    });
    // Each source language needs its own detector; the shape they return is
    // shared, so retrieval and the announced-verse prompt block are reused.
    detectRef =
      cfg.sourceLang === 'en' ? detectReferenceEn : cfg.sourceLang === 'zh' ? detectReferenceZh : detectReference;
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

    // Provisional captions: interim STT text streams to listeners as a
    // dimmed "live" line (throttled), so they see words within ~1s while the
    // audio keeps its coherence delay. Text-only; the audio path is
    // untouched. Note the text is SOURCE-language — a liveness cue.
    let lastPartialSentAt = 0;

    // Set up streaming STT in the direction's input language
    // Recognition bias for this connection. Deepgram bakes keyterms into the
    // connection URL, so this is the one chance to set them: a term added
    // later cannot reach STT without reconnecting, and reconnecting mid-sermon
    // would drop whatever the preacher was part-way through saying. Such a
    // term still improves translation immediately; it biases recognition from
    // the next broadcast.
    const { keyterms, dropped } = budgetKeyterms(
      session.glossaryAll.map((t) => t.sourceTerm),
      // Recognition bias must be in the SPOKEN language. Korean keyterms on
      // Mandarin audio would only bias it toward words nobody is saying.
      cfg.sourceLang === 'zh' ? DEFAULT_KEYTERMS_ZH : DEFAULT_STT_KEYTERMS,
    );
    if (dropped.length > 0) {
      console.warn(
        `[Glossary] ${dropped.length} keyterm(s) over Deepgram's limit, not sent: ${dropped.join(', ')}`,
      );
    }

    stt = new DeepgramSTT({
      apiKey: DEEPGRAM_API_KEY,
      language: sttCfg.language,
      model: sttCfg.model,
      smartFormat: sttCfg.smartFormat,
      keyterms,
      onTranscript: async ({ text, isFinal, timestamp, audioEndSec, audioStartSec }) => {
        // Interims arrive many times per second and exist only to tell the
        // chunker that speech is still flowing — logging them would bury the
        // finals that actually matter.
        if (isFinal) {
          console.log(`[Broadcaster] STT transcript (final=true): "${text.slice(0, 60)}…"`);
        }
        // Send live Korean transcript to broadcaster UI
        // Finals always go to the desk. Interims are throttled to the same
        // cadence as the listener feed below: once interims started being
        // forwarded, this fired several times a second, and the resulting
        // socket traffic starved the audio sender badly enough to lose a
        // third of a test run. A live desk on church wi-fi would fare worse.
        if (isFinal) {
          send(ws, { type: 'transcript', korean: text, isFinal, timestamp, audioStartSec, audioEndSec });
        } else if (text.trim()) {
          const now = Date.now();
          if (now - lastPartialSentAt >= 350) {
            lastPartialSentAt = now;
            send(ws, { type: 'transcript', korean: text, isFinal, timestamp });
            session.broadcast({ type: 'partial_transcript', text, timestamp });
          }
        }

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
    if (preSttAudio.length > 0) {
      const held = preSttAudio;
      preSttAudio = [];
      for (const pcm of held) stt.sendAudio(pcm);
      const sec = held.reduce((n, b) => n + b.length, 0) / 32_000;
      console.log(`[Broadcaster] Handed ${sec.toFixed(1)}s of audio from session start to STT`);
    }
    console.log(`[Broadcaster] Session started, mode = ${mode}, direction = ${direction}`);
  }

  /** End the broadcast — only the owning connection may do this. */
  function stopSession(): void {
    if (!ownsSession) {
      // A non-owner (zombie tab, stale reconnect) tears down only its own
      // leftovers; the live session it never owned continues untouched.
      teardownPipeline();
      return;
    }
    ownsSession = false;
    session.activeBroadcastTeardown = null;
    session.isActive = false;
    session.lastStoppedAt = Date.now();
    teardownPipeline();

    // Flush and mark complete in the background: ending a broadcast must feel
    // instant, and a transcript left 'live' still has its segments and is
    // still viewable.
    const closing = transcript;
    transcript = null;
    void closing?.close().catch((err) => console.warn('[Transcript] Close failed:', err.message));

    session.broadcast({ type: 'status', active: false, direction: session.direction });
    logLatencyReport();
    console.log('[Broadcaster] Session stopped');
  }

  // ── WebSocket message handlers ─────────────────────────────────────────────
  let audioChunkCount = 0;
  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      // Raw PCM audio from broadcaster
      audioChunkCount++;
      if (audioChunkCount % 50 === 1) {
        console.log(`[Broadcaster] Audio chunk #${audioChunkCount}, ${(data as Buffer).byteLength} bytes, stt=${!!stt}, active=${session.isActive}`);
      }
      if (stt && session.isActive) {
        stt.sendAudio(data as Buffer);
      } else if (ownsSession && session.isActive) {
        // This connection's start is still awaiting the database.
        preSttAudio.push(data as Buffer);
        let total = preSttAudio.reduce((n, b) => n + b.length, 0);
        while (total > PRE_STT_MAX_BYTES && preSttAudio.length > 0) total -= preSttAudio.shift()!.length;
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
          // A demo room authorises itself. It was minted by the rate-limited
          // demo API, which is what stands in for a staff login here — a
          // prospect arriving from a cold email has no account yet, and that
          // is the entire point of the funnel.
          //
          // The guard is `session.demo`, NOT the room name: anyone can connect
          // to a socket claiming room "demo-whatever" and have getOrCreate
          // make it, but only the demo API ever sets this field. A guessed
          // name therefore gets an ordinary room and still needs a real login.
          const auth = session.demo ? { ok: true as const, username: null } : isStartAuthorized(msg.token);
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
          // Each church account broadcasts only the languages it is set up
          // for (AUTH_DIRECTIONS). The desk hides the others; this is the
          // check that actually holds.
          if (!allowedDirections(auth.username).includes(direction)) {
            const label = `${getDirectionConfig(direction).sourceLabel} → ${getDirectionConfig(direction).targetLabel}`;
            console.warn(`[Broadcaster] Refused ${direction} for "${auth.username}" in room "${session.roomId}"`);
            send(ws, { type: 'error', message: `This account isn't set up for ${label}.` });
            break;
          }
          try {
            // Awaited: the glossary must be loaded before the translator and
            // the STT connection are built, since both bake it in at construction.
            await startSession(msg.mode === 'smooth' ? 'smooth' : 'fast', direction);
          } catch (err) {
            const message = (err as Error).message;
            console.warn(`[Broadcaster] Start refused for room "${session.roomId}": ${message}`);
            send(ws, { type: 'error', message });
            break;
          }
          // recordingTranscript is whether a writer actually opened, not
          // whether we intended to: with the database unreachable the desk
          // would otherwise show a recording indicator while nothing is kept.
          send(ws, {
            type: 'started',
            mode: session.mode,
            direction: session.direction,
            recordingTranscript: recordingTranscript(),
          });
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
    console.log(`[Broadcaster] Disconnected (room "${session.roomId}", ownsSession=${ownsSession})`);
    stopSession(); // no-op teardown unless this connection owns the broadcast
    session.removeBroadcaster(ws);
  });

  ws.on('error', (err) => {
    console.error('[Broadcaster] WS error:', err.message);
  });
}
