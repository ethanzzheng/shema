/**
 * Sentence assembler — merges STT utterances into complete thoughts, then
 * dispatches them in order, one translation at a time. Boundary detection and
 * timing are per-direction (Korean grammar for ko-en, English punctuation
 * rules for en-ko); everything else is shared.
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

import { looksComplete, splitSentences, endsWithDanglingHead, endsMidThought, splitLastKoreanClause } from './text';
import { looksCompleteEn, splitSentencesEn, splitLastClause } from './text-en';
import { looksCompleteZh, splitSentencesZh, endsDanglingZh, splitLastClauseZh } from './text-zh';
import { looksCompleteYue, splitSentencesYue, endsDanglingYue, splitLastClauseYue } from './text-yue';
import { Direction, isChinese } from './direction-config';
import type { BoundaryOracle } from './boundary-oracle';

// Don't dispatch a lone tiny sentence ("네." alone) — group it with the next.
const MIN_DISPATCH_CHARS = 10;

// The oracle never ships a head shorter than this: a 4-character Chinese
// "thought" is usually a greeting or a tag better kept with what follows.
const ORACLE_MIN_HEAD = 8;

// STT sometimes re-emits the tail of the previous final at the start of the
// next one; only trim when the overlap is long enough to be a real re-send,
// not a coincidental syllable match.
const MIN_STT_OVERLAP_CHARS = 6;

// An incomplete tail shorter than this is a shard ("그렇죠? 그리고 금요일에")
// that reads as a dangling fragment if force-shipped alone. It carries no
// standalone meaning, so give its continuation twice as long to arrive —
// this delays nothing meaningful (the merged sentence lands when it lands).
const TINY_FRAGMENT_CHARS = 25;

// How much of the last dispatched chunk to remember for re-send detection,
// and how long a match still counts as a re-send rather than real repetition.
const DISPATCHED_TAIL_CHARS = 200;
const RESEND_WINDOW_MS = 2500;

/**
 * waitMs = time from the last STT final that fed the buffer to this chunk's
 * dispatch — the chunker's hold cost, the (a) stage of pipeline latency.
 */
export type ChunkCallback = (text: string, seq: number, waitMs: number) => Promise<void>;

/**
 * Language-specific sentence-boundary detection — the ONLY part of chunking
 * that differs by direction. Korean reads grammar off final vs connective
 * endings (text.ts); English reads abbreviation-aware punctuation with a
 * trailing-connective veto (text-en.ts). Timing/queueing/ordering are shared.
 */
interface BoundaryDetector {
  looksComplete(text: string): boolean;
  splitSentences(text: string): { sentences: string[]; remainder: string };
  /**
   * Optional run-on relief: carve a complete clause off an oversized buffer
   * (used with softChars). English needs this — polysyndetic preaching can
   * run 30-40s without a period; Korean marks sentence ends grammatically,
   * so it never accretes like that.
   */
  clauseRelief?: (text: string) => { head: string; rest: string } | null;
  /**
   * Does the buffer end where the head noun / main verb has not arrived yet?
   * Such a buffer gets doubled patience, and when patience runs out only a
   * safe prefix ships (see splitSafe). Absent = no special hold (en-ko).
   */
  holdsForHead?: (text: string) => boolean;
  /** Safe prefix to ship when a held buffer's patience expires. */
  splitSafe?: (text: string) => { head: string; rest: string } | null;
  /**
   * Also prefer splitSafe when an expired or oversized buffer is NOT dangling.
   * Real Mandarin speech arrives with almost no punctuation (24 of 261 chunks
   * in the first real service ended on 。！？), so the end of the buffer is
   * just wherever a pause fell. The last sentence-opening word or tag question
   * inside it is a better cut than that.
   */
  splitWhenExpired?: boolean;
  /**
   * How consecutive STT finals are joined. Chinese has no word spaces, and a
   * stray space inside "约翰福音第 3章16节" is noise to every heuristic.
   */
  joiner: string;
  /** Below this many characters an incomplete buffer is a shard. */
  tinyChars: number;
}

const BOUNDARY_DETECTORS: Record<Direction, BoundaryDetector> = {
  'ko-en': {
    looksComplete,
    splitSentences,
    holdsForHead: (t) => endsWithDanglingHead(t) || endsMidThought(t),
    splitSafe: splitLastKoreanClause,
    joiner: ' ',
    tinyChars: TINY_FRAGMENT_CHARS,
  },
  'en-ko': {
    looksComplete: looksCompleteEn,
    splitSentences: splitSentencesEn,
    clauseRelief: splitLastClause,
    joiner: ' ',
    tinyChars: TINY_FRAGMENT_CHARS,
  },
  // Mandarin packs a whole sentence into very few characters — 我们要彼此相爱
  // is seven — so the shard threshold is far lower than Korean's 25. At 10, a
  // complete seven-character sentence was held 10s as if it were a fragment.
  'zh-en': {
    looksComplete: looksCompleteZh,
    splitSentences: splitSentencesZh,
    holdsForHead: endsDanglingZh,
    splitSafe: splitLastClauseZh,
    splitWhenExpired: true,
    joiner: '',
    tinyChars: 6,
  },
  // Cantonese: the Mandarin rules on folded text, plus Cantonese particles,
  // dangling words and openers (text-yue.ts).
  'yue-en': {
    looksComplete: looksCompleteYue,
    splitSentences: splitSentencesYue,
    holdsForHead: endsDanglingYue,
    splitSafe: splitLastClauseYue,
    splitWhenExpired: true,
    joiner: '',
    tinyChars: 6,
  },
};

export interface ModeConfig {
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
  /**
   * Absolute ceiling on how long one buffer may be held, measured from when it
   * started filling. The patience below is graded — a dangling clause waits
   * longer than a merely-abrupt one — and interim results keep re-arming the
   * timer, so without this a continuously-speaking pastor could hold audio
   * until maxChars (~35s of speech). Latency is bounded here instead.
   */
  maxHoldMs: number;
  /** Hard cap — force a dispatch once the buffer grows past this (run-ons). */
  maxChars: number;
  /** Soft cap: past this, clause relief carves complete clauses off the front. */
  softChars?: number;
  /**
   * Pause-aware cutting (off when absent). If the speaker went quiet for at
   * least this long after the latest final, a buffer that is not dangling is
   * treated as a finished sentence. Chinese recognition emits little sentence
   * punctuation, so the pause is the strongest boundary signal available, and
   * it is known the moment the final arrives.
   */
  pauseCutMs?: number;
}

/** What the speech recogniser knows about the final being fed. */
export interface FinalMeta {
  /** Silence after the last word of this final, in ms. */
  pauseAfterMs?: number;
}

// "Smooth" waits longer for the sentence to complete (most natural pausing);
// "Fast" gives up sooner (lower latency, more mid-sentence cuts).
//
// en-ko waits longer than ko-en at every knob: Korean is verb-final, so an
// English fragment often lacks the very verb the Korean sentence must END
// with — a cut costs more, so more-complete segments are worth the latency.
// maxChars is larger too: English spells more characters per second of
// speech than Hangul syllable blocks do.
const MODE_CONFIG: Record<Direction, Record<'fast' | 'smooth', ModeConfig>> = {
  'ko-en': {
    fast: { completeMs: 250, incompleteMaxMs: 2500, maxChars: 260, maxHoldMs: 8000 },
    smooth: { completeMs: 350, incompleteMaxMs: 5000, maxChars: 400, maxHoldMs: 14000 },
  },
  // Mandarin is SVO, so a cut costs less than in Korean and completeMs/
  // incompleteMaxMs match ko-en. maxChars is far lower: spoken Mandarin runs
  // ~4-5 characters a second, so 400 characters would be ~90s of speech.
  'zh-en': {
    fast: { completeMs: 250, incompleteMaxMs: 2500, maxChars: 120, maxHoldMs: 8000 },
    smooth: { completeMs: 350, incompleteMaxMs: 5000, maxChars: 180, maxHoldMs: 14000 },
  },
  // Cantonese starts from Mandarin's timing. Spoken Cantonese runs a little
  // faster in characters, but the same caps measured fine on four sermons.
  'yue-en': {
    fast: { completeMs: 250, incompleteMaxMs: 2500, maxChars: 120, maxHoldMs: 8000 },
    smooth: { completeMs: 350, incompleteMaxMs: 5000, maxChars: 180, maxHoldMs: 14000 },
  },
  'en-ko': {
    fast: { completeMs: 350, incompleteMaxMs: 3000, maxChars: 340, softChars: 180, maxHoldMs: 9000 },
    smooth: { completeMs: 500, incompleteMaxMs: 6000, maxChars: 520, softChars: 240, maxHoldMs: 16000 },
  },
};

interface ChunkerOptions {
  mode: 'fast' | 'smooth';
  /** Selects boundary detection + timing; default ko-en (the original). */
  direction?: Direction;
  onChunk: ChunkCallback;
  /** Allocates the next sequence number, in spoken order, at dispatch time. */
  nextSeq: () => number;
  /**
   * Overrides for the direction's timing knobs. Evaluation only: the replay
   * harness tries variants with it. Production never passes it, so absent
   * means exactly the built-in config.
   */
  tuning?: Partial<ModeConfig>;
  /**
   * Completeness check for directions with no grammatical sentence ending
   * (Chinese). Absent = rules and timers only, as before.
   */
  oracle?: BoundaryOracle;
}

// Class name is historical (it began Korean-only) — direction-aware since
// en-ko; kept for compatibility with existing imports.
export class KoreanChunker {
  private buffer = '';
  private onChunk: ChunkCallback;
  private nextSeq: () => number;
  private readonly direction: Direction;
  private readonly detector: BoundaryDetector;
  private cfg: ModeConfig;

  private timer: NodeJS.Timeout | null = null;
  /** When the most recent STT final arrived (for dispatch wait attribution). */
  private lastFinalAt = 0;
  /** When the current buffer started filling — bounds total hold time.
   *  -1 means 'no buffer yet'; 0 is a legitimate timestamp. */
  private bufferStartedAt = -1;
  /**
   * Tail of what we most recently dispatched, and when.
   *
   * stripOverlap only compared against the live buffer, which is cleared on
   * dispatch — so a Deepgram re-send arriving just AFTER a dispatch had
   * nothing to compare against and the already-spoken tail was translated and
   * spoken a second time. Keeping a short memory of dispatched text closes
   * that window.
   */
  private dispatchedTail = '';
  private dispatchedAt = 0;

  // Bounded-parallel dispatch queue. 2 = at most one sentence translates ahead
  // of the current one, so context loss during bursts is limited to the
  // immediately-preceding sentence; normal pacing stays effectively serial.
  private static readonly MAX_PARALLEL = 2;
  private pending: { text: string; seq: number; waitMs: number }[] = [];
  private inFlight = 0;
  /** Silence after the latest final, when the caller knows it. */
  private lastPauseMs: number | undefined;

  private readonly oracle: BoundaryOracle | undefined;
  /** One oracle call at a time; a newer buffer waits for the current answer. */
  private oracleBusy = false;
  private oracleWanted = false;
  /** The exact buffer the oracle last judged complete. */
  private oracleComplete: string | null = null;

  constructor(opts: ChunkerOptions) {
    this.onChunk = opts.onChunk;
    this.nextSeq = opts.nextSeq;
    this.direction = opts.direction ?? 'ko-en';
    this.detector = BOUNDARY_DETECTORS[this.direction];
    this.tuning = opts.tuning;
    this.cfg = { ...MODE_CONFIG[this.direction][opts.mode], ...this.tuning };
    this.oracle = opts.oracle;
  }

  private readonly tuning: Partial<ModeConfig> | undefined;

  setMode(mode: 'fast' | 'smooth'): void {
    this.cfg = { ...MODE_CONFIG[this.direction][mode], ...this.tuning };
  }

  async feed(text: string, isFinal: boolean, meta?: FinalMeta): Promise<void> {
    if (!text.trim()) return;
    if (isFinal) this.lastPauseMs = meta?.pauseAfterMs;

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
    this.lastFinalAt = Date.now();

    if (!this.buffer) this.bufferStartedAt = Date.now();
    this.buffer += (this.buffer ? this.detector.joiner : '') + fresh;
    this.cancelTimer();

    // Extract fully-punctuated sentences NOW. During a rapid ramble the buffer
    // tail is perpetually mid-sentence, and waiting on the tail used to hold
    // completed sentences hostage for 10s+. Interior sentences are safe to cut
    // immediately — the speech has already moved past them. Tiny sentences are
    // grouped up to MIN_DISPATCH_CHARS so "네." never ships alone.
    const { sentences, remainder } = this.detector.splitSentences(this.buffer);
    if (sentences.length > 0) {
      let group = '';
      for (const s of sentences) {
        group += (group ? this.detector.joiner : '') + s;
        if (group.length >= MIN_DISPATCH_CHARS) {
          this.dispatchText(group);
          group = '';
        }
      }
      // An undersized trailing group rides along with the remainder.
      this.buffer = group ? group + (remainder ? this.detector.joiner + remainder : '') : remainder;
      // If everything older shipped, what is left is NEW speech and gets a
      // fresh hold budget. Without this the tail inherited the start time of
      // the long buffer it was split from, found maxHoldMs already spent, and
      // shipped instantly — "另外," was spoken alone as "Also" 773ms after
      // it arrived.
      // Mandarin only: Korean keeps the deployed timing.
      if (!group && isChinese(this.direction)) this.bufferStartedAt = Date.now();
    }
    if (!this.buffer) return;

    // Clause relief: a continuous speaker never trips the pause timers, so
    // without periods the buffer used to ride all the way to maxChars
    // (~35-40s of speech) before anything shipped. Past the soft cap, carve
    // complete clauses off the front at comma boundaries instead.
    if (this.cfg.softChars && this.detector.clauseRelief) {
      while (this.buffer.length >= this.cfg.softChars) {
        const relief = this.detector.clauseRelief(this.buffer);
        if (!relief) break;
        this.dispatchText(relief.head);
        this.buffer = relief.rest;
      }
      if (!this.buffer) return;
    }

    // Run-on safety: dispatch immediately once we exceed the hard cap —
    // cutting at the best boundary inside it where the language allows.
    if (this.buffer.length >= this.cfg.maxChars) {
      // Only where the detector asks for it (Mandarin); Korean ships the whole
      // buffer at the cap, as deployed.
      if (!(this.detector.splitWhenExpired && this.shipSafeHead(true))) this.dispatchBuffer();
      return;
    }

    // The remaining tail has no terminal punctuation. If Korean grammar says
    // it's a complete sentence (final ending), dispatch after a short beat;
    // otherwise wait for it to complete — new speech (finals AND interims)
    // resets this timer, so we ride straight through mid-sentence dramatic
    // pauses and only cut at real sentence ends. A fragment ships only after
    // incompleteMaxMs of true quiet.
    this.armTimer();
    this.consultOracle();
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
    // Nothing in the live buffer matched. The buffer is empty right after a
    // dispatch, which is exactly when a re-send lands, so also compare against
    // what we just shipped — but only briefly. A pastor repeating a phrase for
    // emphasis takes seconds to say it again and is genuinely new speech;
    // beyond this window, treat a match as real repetition and keep it.
    if (this.dispatchedTail && Date.now() - this.dispatchedAt < RESEND_WINDOW_MS) {
      const dmax = Math.min(this.dispatchedTail.length, incoming.length);
      for (let k = dmax; k >= MIN_STT_OVERLAP_CHARS; k--) {
        if (this.dispatchedTail.endsWith(incoming.slice(0, k))) {
          return incoming.slice(k).trim();
        }
      }
    }
    return incoming;
  }

  /** (Re)start the pending-buffer timer based on how complete the tail looks. */
  private armTimer(): void {
    this.cancelTimer();
    let delay: number;
    const pausedHere =
      this.cfg.pauseCutMs !== undefined &&
      this.lastPauseMs !== undefined &&
      this.lastPauseMs >= this.cfg.pauseCutMs &&
      this.buffer.length >= this.detector.tinyChars &&
      !this.detector.holdsForHead?.(this.buffer);
    if (this.detector.looksComplete(this.buffer) || pausedHere || this.oracleComplete === this.buffer) {
      delay = this.cfg.completeMs;
    } else if (this.detector.holdsForHead?.(this.buffer)) {
      // The head noun this modifier belongs to has not been spoken yet.
      // Shipping now is what produced the church/self-centeredness inversion,
      // so wait harder for it than for a merely abrupt ending.
      delay = this.cfg.incompleteMaxMs * 2;
    } else {
      delay =
        this.buffer.length < this.detector.tinyChars
          ? this.cfg.incompleteMaxMs * 2 // graded patience: hold tiny shards longer
          : this.cfg.incompleteMaxMs;
    }
    // Never hold one buffer past the ceiling, however incomplete it looks.
    if (this.bufferStartedAt >= 0) {
      const held = Date.now() - this.bufferStartedAt;
      delay = Math.max(0, Math.min(delay, this.cfg.maxHoldMs - held));
    }
    this.timer = setTimeout(() => this.expirePatience(), delay);
  }

  /**
   * Patience ran out. Prefer shipping a safe head and keeping the dangling
   * tail buffered over shipping a modifier with nothing to modify — a
   * fragment that merely sounds clipped is far better than one that attaches
   * to the wrong referent.
   */
  private expirePatience(): void {
    if (!this.shipSafeHead(false)) this.dispatchBuffer();
  }

  /**
   * Ship the safe prefix of the buffer and keep the rest. Applies to a
   * dangling buffer always, and to any buffer when the detector asks for it
   * (splitWhenExpired). Returns false when there is no safe cut.
   */
  private shipSafeHead(oversized: boolean): boolean {
    if (!this.detector.splitSafe) return false;
    const dangling = this.detector.holdsForHead?.(this.buffer) ?? false;
    if (!dangling && !this.detector.splitWhenExpired) return false;
    // A buffer that already ends at a complete sentence ships whole.
    if (!dangling && this.detector.looksComplete(this.buffer)) return false;
    const split = this.detector.splitSafe(this.buffer);
    if (!split) return false;
    // Keeping a tail longer than the head would just defer the problem.
    if (!dangling && !oversized && split.rest.length > split.head.length) return false;
    this.cancelTimer();
    this.dispatchText(split.head);
    this.buffer = split.rest;
    this.bufferStartedAt = Date.now(); // the tail gets its own budget
    this.armTimer();
    return true;
  }

  /**
   * Ask the oracle about the current buffer, in the background. Only one call
   * runs at a time; finals that arrive meanwhile are judged together once it
   * returns. Skipped when the rules are already sure or the buffer is a shard.
   */
  private consultOracle(): void {
    if (!this.oracle || !this.buffer) return;
    if (this.buffer.length < Math.max(this.detector.tinyChars, ORACLE_MIN_HEAD)) return;
    if (this.detector.looksComplete(this.buffer)) return;
    if (this.oracleBusy) {
      this.oracleWanted = true;
      return;
    }
    this.oracleBusy = true;
    const snap = this.buffer;
    this.oracle(snap, { previous: this.dispatchedTail.slice(-60), pauseMs: this.lastPauseMs })
      .then((v) => {
        if (!v || !this.buffer.startsWith(snap)) return; // already shipped
        if (v.complete) {
          // Only for the very buffer it judged: words that arrived since may
          // be the same sentence continuing. They get their own verdict.
          if (this.buffer === snap) {
            this.oracleComplete = snap;
            this.armTimer();
          }
          return;
        }
        if (v.headLen === undefined) return;
        // A complete thought inside the buffer, with the next one already
        // begun: ship it now, as an interior sentence end would be.
        const head = snap.slice(0, v.headLen).trim();
        if (head.length < ORACLE_MIN_HEAD || this.detector.holdsForHead?.(head)) return;
        this.cancelTimer();
        this.dispatchText(head);
        this.buffer = this.buffer.slice(v.headLen).trim();
        this.bufferStartedAt = this.buffer ? Date.now() : -1;
        if (this.buffer) this.armTimer();
      })
      .catch(() => {})
      .finally(() => {
        this.oracleBusy = false;
        if (this.oracleWanted) {
          this.oracleWanted = false;
          this.consultOracle();
        }
      });
  }

  /** Queue one chunk for translation, assigning its spoken-order seq now. */
  private dispatchText(text: string): void {
    this.dispatchedTail = text.slice(-DISPATCHED_TAIL_CHARS);
    this.dispatchedAt = Date.now();
    const seq = this.nextSeq();
    const waitMs = this.lastFinalAt ? Date.now() - this.lastFinalAt : 0;
    this.pending.push({ text, seq, waitMs });
    this.pump();
  }

  /** Dispatch the whole accumulated buffer as one coherent chunk. */
  private dispatchBuffer(): void {
    this.cancelTimer();
    const text = this.buffer.trim();
    this.buffer = '';
    this.bufferStartedAt = -1;
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
      const { text, seq, waitMs } = this.pending.shift()!;
      this.inFlight++;
      console.log(`[Chunker] Dispatching seq ${seq}: ${text.length} chars, waited ${waitMs}ms (${this.inFlight} in flight)`);
      this.onChunk(text, seq, waitMs)
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
