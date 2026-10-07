/**
 * Batched transcript writer.
 *
 * The one hard rule: nothing here may ever sit in the live translation path.
 * `add()` is synchronous, never throws, and only appends to an array; the
 * database is touched on a timer or once a batch has built up, and a failure
 * costs the transcript rather than the sermon.
 */

import { isDbConfigured } from '../db';
import { completeTranscript, insertSegments, openTranscript } from './repo';
import { SegmentTranslation } from './types';

/** Flush once this many segments are waiting... */
const BATCH_SIZE = 10;
/** ...or this long after the first of them arrived, whichever comes first. */
const FLUSH_INTERVAL_MS = 15_000;
/**
 * Stop buffering after this many unwritten segments. A database that has been
 * failing for an entire sermon must not grow the broadcaster's heap; losing
 * the transcript is the acceptable outcome, running the service out of memory
 * is not.
 */
const MAX_BUFFER = 2_000;
/** Consecutive flush failures before the writer gives up for the session. */
const MAX_FAILURES = 5;

export interface Pending {
  seq: number;
  offsetMs: number;
  sourceText: string;
  translations: Record<string, SegmentTranslation>;
}

/**
 * The two database calls the writer makes. Injectable so the behaviour that
 * matters — that `add()` never waits on I/O, and that a failing database
 * cannot grow without bound — is provable without a database.
 */
export interface TranscriptIO {
  insert(transcriptId: string, batch: Pending[]): Promise<void>;
  complete(transcriptId: string): Promise<void>;
}

const DB_IO: TranscriptIO = { insert: insertSegments, complete: completeTranscript };

export class TranscriptWriter {
  private buffer: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private failures = 0;
  private stopped = false;
  private written = 0;
  private dropped = 0;

  constructor(
    readonly transcriptId: string,
    private readonly startedAtMs: number,
    private readonly label: string,
    private readonly io: TranscriptIO = DB_IO,
  ) {}

  /**
   * Begin (or resume) the transcript for a broadcast. Returns null when there
   * is no database or it cannot be reached — the broadcast then simply runs
   * without a transcript, which must never block going on air.
   */
  static async open(input: {
    churchId: string;
    sessionId: string;
    sourceLang: string;
    targetLangs: string[];
    startedAtMs: number;
  }): Promise<TranscriptWriter | null> {
    if (!isDbConfigured()) return null;
    try {
      const t = await openTranscript(input);
      return new TranscriptWriter(t.id, input.startedAtMs, input.churchId);
    } catch (err) {
      console.warn(`[Transcript] Could not open for "${input.churchId}": ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Record one finalized segment. Called from the live emission path, so it
   * does no I/O and cannot throw.
   */
  add(segment: { seq: number; sourceText: string; sermon: string; direct: string; lang: string; timestampMs: number }): void {
    if (this.stopped) return;
    if (this.buffer.length >= MAX_BUFFER) {
      this.dropped++;
      return;
    }
    this.buffer.push({
      seq: segment.seq,
      offsetMs: Math.max(0, segment.timestampMs - this.startedAtMs),
      sourceText: segment.sourceText,
      translations: { [segment.lang]: { sermon: segment.sermon, direct: segment.direct } },
    });

    if (this.buffer.length >= BATCH_SIZE) {
      void this.flush();
    } else if (!this.timer) {
      // Bound how long the first segment of a batch waits, so a quiet sermon
      // still lands on disk and a crash loses seconds rather than minutes.
      this.timer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushing = true;
    // Taken before the await: anything arriving mid-write belongs to the next
    // batch, and the insert is idempotent on (transcript_id, seq) anyway.
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.io.insert(this.transcriptId, batch);
      this.written += batch.length;
      this.failures = 0;
    } catch (err) {
      this.failures++;
      console.warn(
        `[Transcript] Flush failed for "${this.label}" (${this.failures}/${MAX_FAILURES}): ${(err as Error).message}`,
      );
      if (this.failures >= MAX_FAILURES) {
        this.stopped = true;
        this.dropped += batch.length;
        console.error(`[Transcript] Giving up on "${this.label}" for this session; the service is unaffected.`);
      } else {
        // Put them back at the front so spoken order survives a retry.
        this.buffer = batch.concat(this.buffer);
      }
    } finally {
      this.flushing = false;
      if (this.buffer.length >= BATCH_SIZE && !this.stopped) void this.flush();
    }
  }

  /** Final flush and mark complete. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Wait out an in-flight flush so the last batch is not written twice or
    // raced past by the status update.
    for (let i = 0; i < 50 && this.flushing; i++) await new Promise((r) => setTimeout(r, 50));
    if (!this.stopped) await this.flush().catch(() => {});
    try {
      await this.io.complete(this.transcriptId);
    } catch (err) {
      // A transcript left 'live' still has its segments and is still viewable;
      // this is cosmetic, not data loss.
      console.warn(`[Transcript] Could not mark complete: ${(err as Error).message}`);
    }
    this.stopped = true;
    console.log(
      `[Transcript] Closed "${this.label}": ${this.written} segment(s) written` +
        (this.dropped > 0 ? `, ${this.dropped} dropped` : ''),
    );
  }

  stats(): { written: number; buffered: number; dropped: number; stopped: boolean } {
    return { written: this.written, buffered: this.buffer.length, dropped: this.dropped, stopped: this.stopped };
  }
}
