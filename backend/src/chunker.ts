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
 * Ordering: seq is assigned at dispatch time (spoken order). Translations run
 * with bounded parallelism (see pump); the broadcaster re-orders completions by
 * seq before emitting text/TTS, so listeners always hear spoken order.
 */

import { looksComplete, splitSentences } from './text';

// Don't dispatch a lone tiny sentence ("네." alone) — group it with the next.
const MIN_DISPATCH_CHARS = 10;

// STT sometimes re-emits the tail of the previous final at the start of the
// next one; only trim when the overlap is long enough to be a real re-send,
// not a coincidental syllable match.
const MIN_STT_OVERLAP_CHARS = 6;

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

  // Bounded-parallel dispatch queue. 2 = at most one sentence translates ahead
  // of the current one, so context loss during bursts is limited to the
  // immediately-preceding sentence; normal pacing stays effectively serial.
  private static readonly MAX_PARALLEL = 2;
  private pending: { text: string; seq: number }[] = [];
  private inFlight = 0;

  constructor(opts: ChunkerOptions) {
    this.onChunk = opts.onChunk;
    this.nextSeq = opts.nextSeq;
    this.cfg = MODE_CONFIG[opts.mode];
  }

  setMode(mode: 'fast' | 'smooth'): void {
    this.cfg = MODE_CONFIG[mode];
  }

  async feed(text: string, isFinal: boolean): Promise<void> {
    if (!text.trim()) return;

    if (!isFinal) {
      // An interim result means the speaker is mid-word RIGHT NOW. Re-arm any
      // pending timer so the incomplete-fragment timeout measures TRUE silence,
      // not Deepgram's finalization lag — force-shipping while speech was still
      // flowing is what cut sentences into shards even though the pastor never
      // actually paused that long.
      if (this.timer && this.buffer) this.armTimer();
      return;
    }

    // Deepgram occasionally re-emits the previous final's text at the start of
    // the next one. Appending blindly doubles the clause ("...사랑이 있는지
    // 사랑이 있는지 우리는...") and the doubled Korean gets faithfully — and
    // nonsensically — translated. Trim the re-sent overlap before appending.
    const fresh = this.stripOverlap(text.trim());
    if (!fresh) return; // pure duplicate of what we already have

    this.buffer += (this.buffer ? ' ' : '') + fresh;
    this.cancelTimer();

    // Extract fully-punctuated sentences NOW. During a rapid ramble the buffer
    // tail is perpetually mid-sentence, and waiting on the tail used to hold
    // completed sentences hostage for 10s+. Interior sentences are safe to cut
    // immediately — the speech has already moved past them. Tiny sentences are
    // grouped up to MIN_DISPATCH_CHARS so "네." never ships alone.
    const { sentences, remainder } = splitSentences(this.buffer);
    if (sentences.length > 0) {
      let group = '';
      for (const s of sentences) {
        group += (group ? ' ' : '') + s;
        if (group.length >= MIN_DISPATCH_CHARS) {
          this.dispatchText(group);
          group = '';
        }
      }
      // An undersized trailing group rides along with the remainder.
      this.buffer = group ? group + (remainder ? ' ' + remainder : '') : remainder;
    }
    if (!this.buffer) return;

    // Run-on safety: dispatch immediately once we exceed the hard cap.
    if (this.buffer.length >= this.cfg.maxChars) {
      this.dispatchBuffer();
      return;
    }

    // The remaining tail has no terminal punctuation. If Korean grammar says
    // it's a complete sentence (final ending), dispatch after a short beat;
    // otherwise wait for it to complete — new speech (finals AND interims)
    // resets this timer, so we ride straight through mid-sentence dramatic
    // pauses and only cut at real sentence ends. A fragment ships only after
    // incompleteMaxMs of true quiet.
    this.armTimer();
  }

  /** Flush + dispatch everything, then wait for in-flight translations to finish. */
  async forceFlush(): Promise<void> {
    this.cancelTimer();
    this.dispatchBuffer();
    while (this.inFlight > 0 || this.pending.length > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  destroy(): void {
    this.cancelTimer();
    this.buffer = '';
    this.pending = [];
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Trim the longest STT re-send overlap: the longest prefix of `incoming`
   * that is already the suffix of the buffer. Returns the genuinely new text
   * ('' if the whole final is a duplicate). Overlaps shorter than
   * MIN_STT_OVERLAP_CHARS are kept — too short to distinguish a re-send from
   * a legitimately repeated syllable.
   */
  private stripOverlap(incoming: string): string {
    const max = Math.min(this.buffer.length, incoming.length);
    for (let k = max; k >= MIN_STT_OVERLAP_CHARS; k--) {
      if (this.buffer.endsWith(incoming.slice(0, k))) {
        return incoming.slice(k).trim();
      }
    }
    return incoming;
  }

  /** (Re)start the pending-buffer timer based on how complete the tail looks. */
  private armTimer(): void {
    this.cancelTimer();
    const delay = looksComplete(this.buffer) ? this.cfg.completeMs : this.cfg.incompleteMaxMs;
    this.timer = setTimeout(() => this.dispatchBuffer(), delay);
  }

  /** Queue one chunk for translation, assigning its spoken-order seq now. */
  private dispatchText(text: string): void {
    const seq = this.nextSeq();
    this.pending.push({ text, seq });
    this.pump();
  }

  /** Dispatch the whole accumulated buffer as one coherent chunk. */
  private dispatchBuffer(): void {
    this.cancelTimer();
    const text = this.buffer.trim();
    this.buffer = '';
    if (text) this.dispatchText(text);
  }

  /**
   * Start queued sentences in spoken order, allowing up to MAX_PARALLEL
   * translations in flight. With an empty queue this behaves exactly like the
   * old serial pump (one at a time, full context). During a backlog — a rapid
   * ramble where Deepgram releases several sentences at once — the overlap
   * drains the queue in ~max(translation time) instead of the sum, which is
   * what shortens the long between-burst pauses. Downstream emission is
   * re-ordered by seq in the broadcaster, so playback order never changes.
   */
  private pump(): void {
    while (this.pending.length > 0 && this.inFlight < KoreanChunker.MAX_PARALLEL) {
      const { text, seq } = this.pending.shift()!;
      this.inFlight++;
      console.log(`[Chunker] Dispatching seq ${seq}: ${text.length} chars (${this.inFlight} in flight)`);
      this.onChunk(text, seq)
        .catch((err) => console.error('[Chunker] onChunk error:', err))
        .finally(() => {
          this.inFlight--;
          this.pump();
        });
    }
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
