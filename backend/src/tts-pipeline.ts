/**
 * Ordered, pipelined TTS streamer.
 *
 * The old worker was strictly serial: clip N+1's synthesis didn't START until
 * clip N's stream was fully consumed, so every sentence boundary paid
 * ElevenLabs' time-to-first-byte from a standing start — and one slow request
 * stalled every sentence behind it. Those were the multi-second silent gaps
 * on the listener while translated text sat waiting.
 *
 * Here, synthesis for up to `prefetch` clips runs concurrently, but output is
 * FORWARDED strictly in enqueue order: the head of the line streams live
 * (onStart/onChunk/onEnd); later clips buffer their audio until they become
 * head, then flush instantly. Listeners still receive one ordered stream —
 * the gap between clips just no longer includes the next clip's first-byte
 * wait.
 *
 * A synthesis failure before ANY audio was produced is retried once; after
 * partial audio it is not (a retry would duplicate what was already sent) —
 * the clip ends early and the line moves on.
 */

export interface TtsStats {
  ttsLatencyMs: number;
  /** Time to first audio byte, or -1 if the clip produced no audio. */
  firstByteMs: number;
  /** Absolute timestamp of the first audio byte (0 if none) — lets the
   *  caller attribute latency against ITS OWN timeline (e.g. enqueue time,
   *  which includes queue wait that firstByteMs cannot see). */
  firstByteAt: number;
}

interface TtsPipelineOptions<J> {
  /** Max clips synthesising at once (head + lookahead). Keep within the TTS plan's concurrency limit. */
  prefetch?: number;
  synth: (text: string, onChunk: (chunk: Buffer) => void) => Promise<void>;
  onStart: (job: J) => void;
  onChunk: (job: J, chunk: Buffer) => void;
  onEnd: (job: J, stats: TtsStats) => void;
  /** Called when a clip's synthesis is abandoned (after any retry). */
  onError?: (job: J, err: unknown) => void;
}

interface Entry<J> {
  job: J;
  buffered: Buffer[];
  synthDone: boolean;
  headStarted: boolean;
  startedAt: number;
  firstChunkAt: number;
}

export class TtsPipeline<J extends { text: string }> {
  private queue: J[] = [];
  private active: Entry<J>[] = [];
  private readonly prefetch: number;

  constructor(private opts: TtsPipelineOptions<J>) {
    this.prefetch = opts.prefetch ?? 2;
  }

  enqueue(job: J): void {
    this.queue.push(job);
    this.pump();
  }

  /** Clips queued or synthesising. 0 = the audio stream is starved of input. */
  get depth(): number {
    return this.queue.length + this.active.length;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private pump(): void {
    while (this.queue.length > 0 && this.active.length < this.prefetch) {
      const entry: Entry<J> = {
        job: this.queue.shift()!,
        buffered: [],
        synthDone: false,
        headStarted: false,
        startedAt: Date.now(),
        firstChunkAt: 0,
      };
      this.active.push(entry);
      if (this.active[0] === entry) this.beginHead(entry);
      void this.run(entry);
    }
  }

  /** Promote a clip to live streaming: emit start, flush anything buffered. */
  private beginHead(entry: Entry<J>): void {
    entry.headStarted = true;
    this.opts.onStart(entry.job);
    for (const chunk of entry.buffered) this.opts.onChunk(entry.job, chunk);
    entry.buffered = [];
    if (entry.synthDone) this.finishHead();
  }

  private finishHead(): void {
    const entry = this.active.shift()!;
    this.opts.onEnd(entry.job, {
      ttsLatencyMs: Date.now() - entry.startedAt,
      firstByteMs: entry.firstChunkAt ? entry.firstChunkAt - entry.startedAt : -1,
      firstByteAt: entry.firstChunkAt,
    });
    const next = this.active[0];
    if (next && !next.headStarted) this.beginHead(next);
    this.pump();
  }

  private async run(entry: Entry<J>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.opts.synth(entry.job.text, (chunk) => {
          if (!entry.firstChunkAt) entry.firstChunkAt = Date.now();
          if (entry.headStarted) this.opts.onChunk(entry.job, chunk);
          else entry.buffered.push(chunk);
        });
        break;
      } catch (err) {
        if (attempt === 0 && !entry.firstChunkAt) {
          console.warn('[TtsPipeline] Synthesis failed before first byte, retrying:', err);
          continue;
        }
        this.opts.onError?.(entry.job, err);
        break;
      }
    }
    entry.synthDone = true;
    if (entry.headStarted && this.active[0] === entry) this.finishHead();
  }
}
