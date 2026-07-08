/**
 * Jitter-buffered, in-order MP3 playback queue.
 *
 * Receives base64-encoded MP3 clips tagged with a spoken-order sequence number
 * and plays them back IN ORDER. TTS clips are generated in parallel so they can
 * arrive slightly out of order — early arrivals are held until their turn.
 *
 * The goal is CONTINUOUS audio, not injected silence. So:
 *
 *   - Jitter buffer (once per burst): when playback is idle and a clip arrives,
 *     we wait a short PREBUFFER window (or until a few clips are ready) before
 *     starting. That small head start lets playback run slightly behind the
 *     arrival stream, absorbing normal timing jitter so we don't underrun.
 *
 *   - Gapless within a burst: while already playing, contiguous clips are
 *     scheduled strictly back-to-back at nextPlayAt — NO per-clip cushion.
 *     (The old code added a cushion on every catch-up, sprinkling silence
 *     between nearly every clip. That was the choppiness.)
 *
 *   - Fast gap skip: if the next expected clip is genuinely missing (a
 *     translation/TTS failure) but later clips are waiting, we skip it after a
 *     short timeout rather than freezing playback.
 */

const PREBUFFER_MS = 450;    // idle → wait this long after a clip arrives before starting a burst
const PREBUFFER_CLIPS = 3;   // ...or start immediately once this many contiguous clips are ready
const BURST_LEAD_SEC = 0.06; // tiny head start when (re)starting a burst
const GAP_SKIP_MS = 700;     // skip a missing seq after this long if later clips are waiting
const MAX_BUFFERED = 32;     // hard cap on out-of-order clips held in memory

export class AudioPlaybackQueue {
  /** Fires when a clip's audio actually begins playing (the spoken seq). */
  onSeqStart: ((seq: number) => void) | null = null;

  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private volume = 1;
  private buffers = new Map<number, AudioBuffer>(); // seq → decoded audio, awaiting its turn
  private expectedSeq: number | null = null; // next seq to play (null until first clip seen)
  private nextPlayAt = 0; // ctx.currentTime at which the next clip should start
  private active = false;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private prebufferTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    this.active = true;
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    this.reset();
  }

  /** Output volume, 0–1. Applies immediately and to future start() calls. */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain) this.masterGain.gain.value = this.volume;
  }

  stop(): void {
    this.active = false;
    this.clearTimers();
    this.buffers.clear();
    this.expectedSeq = null;
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      this.masterGain = null;
    }
  }

  /** Reset ordering state without tearing down the audio context.
   *  Call when a new broadcast starts (seq numbering restarts). */
  reset(): void {
    this.clearTimers();
    this.buffers.clear();
    this.expectedSeq = null;
    if (this.ctx) this.nextPlayAt = this.ctx.currentTime;
  }

  /** Enqueue a base64-encoded MP3 clip tagged with its spoken-order seq. */
  async enqueue(seq: number, base64Mp3: string): Promise<void> {
    if (!this.active || !this.ctx) return;

    try {
      const binary = atob(base64Mp3);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const audioBuffer = await this.ctx.decodeAudioData(bytes.buffer.slice(0));
      if (!this.active) return;

      // Ignore stale clips whose turn already passed (e.g. a late arrival after
      // we skipped its seq).
      if (this.expectedSeq !== null && seq < this.expectedSeq) return;

      // First clip ever (or after a reset) anchors where playback begins.
      if (this.expectedSeq === null) this.expectedSeq = seq;

      this.buffers.set(seq, audioBuffer);

      // Safety valve: if a permanent gap has let the buffer balloon, jump
      // forward to the earliest clip we're holding.
      if (this.buffers.size > MAX_BUFFERED) {
        const earliest = Math.min(...this.buffers.keys());
        if (earliest > this.expectedSeq) this.expectedSeq = earliest;
      }

      this.schedule();
    } catch (err) {
      console.error('[Playback] Decode error:', err);
    }
  }

  // ── scheduling ───────────────────────────────────────────────────────────

  private isPlaying(): boolean {
    return !!this.ctx && this.nextPlayAt > this.ctx.currentTime + 0.05;
  }

  private schedule(): void {
    if (!this.active || !this.ctx || this.expectedSeq === null) return;

    if (this.isPlaying()) {
      // Mid-burst: append any newly-contiguous clips back-to-back, no gap.
      this.drainContiguous();
      return;
    }

    // Idle: decide when to (re)start a burst.
    const ready = this.contiguousReady();
    if (ready === 0) {
      // The expected clip itself is missing — wait briefly, then skip it.
      if (this.buffers.size > 0) this.armGapTimer();
      return;
    }
    if (ready >= PREBUFFER_CLIPS) {
      this.startBurst();
    } else {
      this.armPrebufferTimer();
    }
  }

  /** Begin a fresh playback burst, giving it a small head start (jitter buffer). */
  private startBurst(): void {
    this.clearPrebufferTimer();
    if (!this.ctx) return;
    this.nextPlayAt = this.ctx.currentTime + BURST_LEAD_SEC;
    this.drainContiguous();
  }

  /** Schedule every contiguous clip from expectedSeq, strictly back-to-back. */
  private drainContiguous(): void {
    if (!this.ctx || this.expectedSeq === null) return;

    while (this.buffers.has(this.expectedSeq)) {
      const seq = this.expectedSeq;
      const buffer = this.buffers.get(seq)!;
      this.buffers.delete(seq);

      const startAt = Math.max(this.nextPlayAt, this.ctx.currentTime);
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.masterGain ?? this.ctx.destination);
      source.start(startAt);

      // Announce the spoken seq when its clip actually begins.
      if (this.onSeqStart) {
        const delayMs = Math.max(0, (startAt - this.ctx.currentTime) * 1000);
        setTimeout(() => this.onSeqStart?.(seq), delayMs);
      }

      this.nextPlayAt = startAt + buffer.duration;
      this.expectedSeq++;
      this.clearGapTimer();
    }

    // A gap remains but we hold later clips — don't stall forever.
    if (this.buffers.size > 0 && !this.buffers.has(this.expectedSeq)) {
      this.armGapTimer();
    }
  }

  /** Count clips ready to play contiguously starting at expectedSeq. */
  private contiguousReady(): number {
    if (this.expectedSeq === null) return 0;
    let n = 0;
    let s = this.expectedSeq;
    while (this.buffers.has(s)) {
      n++;
      s++;
    }
    return n;
  }

  // ── timers ───────────────────────────────────────────────────────────────

  private armPrebufferTimer(): void {
    if (this.prebufferTimer) return;
    this.prebufferTimer = setTimeout(() => {
      this.prebufferTimer = null;
      if (this.active && !this.isPlaying() && this.contiguousReady() > 0) {
        this.startBurst();
      }
    }, PREBUFFER_MS);
  }

  private armGapTimer(): void {
    if (this.gapTimer) return;
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      if (!this.active || this.expectedSeq === null || this.buffers.size === 0) return;
      const earliest = Math.min(...this.buffers.keys());
      if (earliest <= this.expectedSeq) return;
      console.warn(`[Playback] Skipping missing seq ${this.expectedSeq} → ${earliest} after ${GAP_SKIP_MS}ms`);
      this.expectedSeq = earliest;
      this.schedule();
    }, GAP_SKIP_MS);
  }

  private clearGapTimer(): void {
    if (this.gapTimer) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  private clearPrebufferTimer(): void {
    if (this.prebufferTimer) {
      clearTimeout(this.prebufferTimer);
      this.prebufferTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearGapTimer();
    this.clearPrebufferTimer();
  }

  get isActive(): boolean {
    return this.active && this.isPlaying();
  }
}
