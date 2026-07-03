/**
 * Korean sentence assembler — merges STT utterances into complete thoughts,
 * then dispatches them in order, one translation at a time.
 *
 * The problem this solves: a preacher pauses dramatically MID-sentence, and the
 * STT finalizes an utterance at every pause. Translating each tiny piece on its
 * own produces 1–3 word fragments ("God", "will meet that need for you"). So we
 * buffer incoming utterances and only dispatch when we have a real sentence:
 *
 *   - Strong punctuation (. ? !) AND enough text  → dispatch after a short beat
 *     (lets a trailing clause attach first).
 *   - A genuine pause (no new speech for `pauseMs`) → the speaker actually
 *     stopped, so dispatch whatever has accumulated.
 *   - Hard length cap (`maxChars`)               → bound latency on run-ons.
 *
 * Ordering (unchanged): seq is assigned at dispatch time (spoken order) and
 * translations run serialized, so context and order are preserved end-to-end.
 */

import { looksComplete } from './text';

export type ChunkCallback = (text: string, seq: number) => Promise<void>;

interface ModeConfig {
  /** Grammatically complete sentence: dispatch after this brief beat. */
  completeMs: number;
  /**
   * Incomplete sentence: how long to keep waiting for it to finish before
   * giving up and dispatching a fragment. We deliberately ride through the
   * pastor's dramatic MID-sentence pauses (which can be several seconds) so we
   * only ever cut at real sentence boundaries — that's what keeps the English
   * pausing where the pastor pauses instead of mid-thought.
   */
  incompleteMaxMs: number;
  /** Hard cap — force a dispatch once the buffer grows past this (run-ons). */
  maxChars: number;
}

// "Smooth" waits longer for the sentence to complete (most natural pausing);
// "Fast" gives up sooner (lower latency, more mid-sentence cuts).
const MODE_CONFIG: Record<'fast' | 'smooth', ModeConfig> = {
  fast: { completeMs: 250, incompleteMaxMs: 2500, maxChars: 260 },
  smooth: { completeMs: 350, incompleteMaxMs: 5000, maxChars: 400 },
};

interface ChunkerOptions {
  mode: 'fast' | 'smooth';
  onChunk: ChunkCallback;
  /** Allocates the next sequence number, in spoken order, at dispatch time. */
  nextSeq: () => number;
}

export class KoreanChunker {
  private buffer = '';
  private onChunk: ChunkCallback;
  private nextSeq: () => number;
  private cfg: ModeConfig;

  private timer: NodeJS.Timeout | null = null;

  // Serialized dispatch queue — sentences translate one at a time, in order.
  private pending: { text: string; seq: number }[] = [];
  private running = false;

  constructor(opts: ChunkerOptions) {
    this.onChunk = opts.onChunk;
    this.nextSeq = opts.nextSeq;
    this.cfg = MODE_CONFIG[opts.mode];
  }

  setMode(mode: 'fast' | 'smooth'): void {
    this.cfg = MODE_CONFIG[mode];
  }

  async feed(text: string, isFinal: boolean): Promise<void> {
    if (!isFinal || !text.trim()) return;

    this.buffer += (this.buffer ? ' ' : '') + text.trim();
    this.cancelTimer();

    // Run-on safety: dispatch immediately once we exceed the hard cap.
    if (this.buffer.length >= this.cfg.maxChars) {
      this.dispatchBuffer();
      return;
    }

    // Dispatch only at grammatically COMPLETE sentences (short beat). If the
    // sentence isn't finished, wait a long time for it to complete — new speech
    // resets this timer, so we ride straight through mid-sentence pauses and
    // only cut at real sentence ends. A fragment is dispatched only if the
    // pastor never completes the thought within incompleteMaxMs.
    const delay = looksComplete(this.buffer) ? this.cfg.completeMs : this.cfg.incompleteMaxMs;

    this.timer = setTimeout(() => this.dispatchBuffer(), delay);
  }

  /** Flush + dispatch everything, then wait for in-flight translations to finish. */
  async forceFlush(): Promise<void> {
    this.cancelTimer();
    this.dispatchBuffer();
    while (this.running || this.pending.length > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  destroy(): void {
    this.cancelTimer();
    this.buffer = '';
    this.pending = [];
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Dispatch the whole accumulated buffer as one coherent chunk. */
  private dispatchBuffer(): void {
    this.cancelTimer();
    const text = this.buffer.trim();
    this.buffer = '';
    if (!text) return;

    const seq = this.nextSeq();
    this.pending.push({ text, seq });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const { text, seq } = this.pending.shift()!;
        console.log(`[Chunker] Dispatching seq ${seq}: ${text.length} chars`);
        try {
          await this.onChunk(text, seq);
        } catch (err) {
          console.error('[Chunker] onChunk error:', err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
