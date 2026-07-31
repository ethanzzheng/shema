/**
 * Progressive MP3 playback via MediaSource Extensions.
 *
 * The backend forwards each sentence's MP3 chunks as they synthesise (in order),
 * so we append them to a single `audio/mpeg` SourceBuffer and let the browser
 * play a continuous stream — audio starts before a clip finishes synthesising,
 * and clips run gaplessly into each other.
 *
 * Playback deliberately runs through a real HTMLAudioElement and NEVER
 * through an AudioContext: the OS treats a playing media element like a
 * podcast (keeps it alive with the screen off / app switched, shows
 * lock-screen controls via Media Session), whereas AudioContext output is
 * suspended in the background on iOS.
 *
 * Chrome/Android support `audio/mpeg` in classic MediaSource; iOS 17.1+
 * provides ManagedMediaSource instead — use it when present. Call
 * `isSupported()` and fall back to the per-clip AudioPlaybackQueue if
 * neither works (older iPhones — those will pause in the background).
 */

/** ManagedMediaSource (iOS/Safari 17.1+) or classic MediaSource, if usable. */
function mediaSourceClass(): typeof MediaSource | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { ManagedMediaSource?: typeof MediaSource; MediaSource?: typeof MediaSource };
  for (const MS of [w.ManagedMediaSource, w.MediaSource]) {
    if (MS && typeof MS.isTypeSupported === 'function' && MS.isTypeSupported('audio/mpeg')) return MS;
  }
  return null;
}

export class AudioStreamPlayer {
  private audioEl: HTMLAudioElement | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private pending: { bytes: Uint8Array; seq: number | null }[] = [];
  private active = false;
  private volume = 1;
  private muted = false;
  private sinkId = '';

  // ── Starvation-resume warmup ──────────────────────────────────────────────
  // Translation gaps drain the buffer at nearly every sentence boundary, so
  // almost every clip begins with a resume-from-empty. TTS clips carry only
  // ~30–130ms of leading silence, and a resume can start late (MSE stall
  // recovery, clock overshoot on Safari/MMS) or into a sleeping output device
  // (Bluetooth wake ≈ hundreds of ms) — either way the sentence's first word
  // gets swallowed. Clips END with ~300–450ms of silence though, so on every
  // starvation-resume we seek back WARMUP_SEC into the previous clip's silent
  // tail before playing: the audio path wakes during silence and the new
  // words begin on a warm device. The explicit seek also corrects any clock
  // drift past the buffered edge.
  private static readonly WARMUP_SEC = 0.3;
  /** Don't resume until this much of the new clip is buffered (prevents an
   *  immediate re-starve → re-rewind stutter when chunks trickle in). */
  private static readonly MIN_AHEAD_SEC = 0.25;
  /** Within this window after a resume, re-starves play on without another
   *  rewind — rapid rewind loops would stutter the sentence onset. */
  private static readonly RESUME_COOLDOWN_MS = 500;
  private starved = true; // starts starved: the very first clip anchors at 0
  private starvedClipStart: number | null = null;
  private lastResumeAt = 0;

  // ── Stall watchdog ────────────────────────────────────────────────────────
  // Observed live on iPhone: the page stays connected and text keeps
  // flowing, but the media pipeline dies silently (MediaSource closes after
  // an OS interruption / element error / appends failing) and the sermon
  // goes mute with the UI still saying "live". There is no in-place recovery
  // from a closed MediaSource — detect the death and ask the owner to
  // REBUILD the whole player.
  /** Fired once when the stream is unrecoverably stalled. */
  onStalled: (() => void) | null = null;
  /** Listener opt-out for automatic catch-up speed (rate pins to 1.0). */
  catchUpEnabled = true;
  /** Where the catch-up ramp is heading (rates glide, never jump). */
  private rateTarget = 1.0;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgressTime = -1;
  private stallTicks = 0;
  private appendFailures = 0;
  private hadOpened = false;
  private startedAtMs = 0;

  private checkHealth(): void {
    const el = this.audioEl;
    const ms = this.mediaSource;
    if (!this.active || !el || !ms) return;
    if (ms.readyState === 'closed') {
      // 'closed' is the NORMAL state until the element attaches the source —
      // fatal only if it closed after opening, or never opens at all.
      if (this.hadOpened) return this.fatal('MediaSource closed');
      if (Date.now() - this.startedAtMs > 8000) return this.fatal('MediaSource never opened');
      return;
    }
    if (el.error) return this.fatal(`element error: ${el.error.message || el.error.code}`);
    const end = this.bufferedEnd();
    const ahead = end !== null ? end - el.currentTime : 0;

    // ── Drift catch-up ──────────────────────────────────────────────────
    // Dense preaching outpaces the pipeline (Korean renderings often take
    // longer to SAY than the English did), so the queued audio can drift
    // minutes behind live. Nothing is ever dropped — instead, when the
    // backlog runs deep, play slightly fast (browsers pitch-correct by
    // default, so it just sounds brisk) and ease back to 1.0 near live.
    // Tiers tuned against a measured live emission ratio of 1.23x (fast
    // preacher + Korean rendering): the first tier must BEAT that ratio or
    // backlog creeps until the next tier. Steady state ≈ the first threshold.
    // Floor at ~10s: catching up all the way to the live edge sounds CHOPPY —
    // the buffer hits zero between clips (each sentence costs ~2-3s of
    // pipeline latency) and every line starts from a starvation-resume.
    // A deliberate cushion absorbs those inter-clip gaps; only genuine
    // speaker pauses reach the listener's ears.
    // 1.15x max: gentle enough to stack with a TTS-side speed bump without
    // reaching the 1.3-1.5x territory reviewers reject. Deep backlogs rely
    // on the Jump-to-live control, not speed.
    if (!this.catchUpEnabled) this.rateTarget = 1.0;
    else if (ahead > 15) this.rateTarget = 1.15;
    else if (ahead < 10) this.rateTarget = 1.0; // hysteresis: hold target between 10-15s
    // RAMP toward the target — abrupt rate jumps glitch audibly (a brief
    // stutter at every tier change). ~0.08 per 1.5s tick ≈ a gentle glide.
    const cur = el.playbackRate;
    let next = cur;
    if (Math.abs(this.rateTarget - cur) <= 0.08) next = this.rateTarget;
    else next = Math.round((cur + Math.sign(this.rateTarget - cur) * 0.08) * 100) / 100;
    if (next !== cur) {
      el.playbackRate = next;
      if (next === this.rateTarget) console.log(`[AudioStream] backlog ${ahead.toFixed(1)}s → playbackRate ${next}`);
    }

    // With real audio buffered ahead and no starvation pending, the playhead
    // must be moving. Frozen playhead → nudge once, then declare it dead.
    if (ahead > 1.5 && !this.starved) {
      if (el.currentTime === this.lastProgressTime) {
        this.stallTicks++;
        if (this.stallTicks === 2) el.play().catch(() => {});
        if (this.stallTicks >= 4) return this.fatal('playhead frozen with buffered audio');
      } else {
        this.stallTicks = 0;
      }
    } else {
      this.stallTicks = 0;
    }
    this.lastProgressTime = el.currentTime;
  }

  private fatal(reason: string): void {
    console.warn(`[AudioStream] unrecoverable stall (${reason}) — requesting rebuild`);
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    const cb = this.onStalled;
    this.onStalled = null; // fire once
    cb?.();
  }

  // ── Spoken-seq tracking ───────────────────────────────────────────────────
  // Each appended chunk carries its sentence seq, so we can map every seq to
  // its time range in the element's timeline. On 'timeupdate' we report which
  // seq the playhead is inside — that's the sentence actually being HEARD
  // (translations arrive ahead of their audio, so "latest translation" runs
  // ahead of the ear). Accuracy is bounded by append granularity (~±0.3s).
  onSeqPlaying: ((seq: number) => void) | null = null;
  private seqRanges = new Map<number, { start: number; end: number }>();
  private lastAppendedSeq: number | null = null;
  private lastNotifiedSeq: number | null = null;

  static isSupported(): boolean {
    return mediaSourceClass() !== null;
  }

  /** Must be called from a user gesture so autoplay is unlocked. */
  start(): void {
    if (this.active) return;
    const MS = mediaSourceClass();
    if (!MS) return;
    this.active = true;

    this.audioEl = new Audio();
    this.audioEl.autoplay = true;
    this.audioEl.volume = this.volume;
    this.audioEl.muted = this.muted;
    // Pitch-corrected rate changes (explicit: Safari needs the webkit name).
    const elp = this.audioEl as HTMLAudioElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean };
    elp.preservesPitch = true;
    elp.webkitPreservesPitch = true;
    if (this.sinkId) this.setSinkId(this.sinkId);
    // Podcast-style element: inline (no fullscreen takeover on iOS)...
    (this.audioEl as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    this.audioEl.setAttribute('playsinline', '');
    // ...and ManagedMediaSource requires remote playback (AirPlay) disabled.
    const w = window as unknown as { ManagedMediaSource?: typeof MediaSource };
    if (w.ManagedMediaSource && MS === w.ManagedMediaSource) {
      (this.audioEl as HTMLAudioElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    }
    // The element fires 'waiting' when it runs out of buffered data — that
    // marks the next append as a starvation-resume needing warmup.
    this.audioEl.addEventListener('waiting', () => {
      this.starved = true;
    });
    // Report which sentence the playhead is inside (fires ~4x/second).
    this.audioEl.addEventListener('timeupdate', () => {
      if (!this.onSeqPlaying || !this.audioEl) return;
      const t = this.audioEl.currentTime;
      for (const [seq, r] of this.seqRanges) {
        if (t >= r.start && t < r.end) {
          if (seq !== this.lastNotifiedSeq) {
            this.lastNotifiedSeq = seq;
            this.onSeqPlaying(seq);
          }
          return;
        }
      }
    });
    this.mediaSource = new MS();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.audioEl.src = this.objectUrl;
    this.mediaSource.addEventListener('sourceopen', this.onSourceOpen);
    this.mediaSource.addEventListener('sourceclose', () => {
      // Only fatal if it had actually opened; a close during attach is part
      // of normal setup churn.
      if (this.active && this.hadOpened) this.fatal('sourceclose event');
    });
    this.startedAtMs = Date.now();
    this.healthTimer = setInterval(() => this.checkHealth(), 1500);
    this.audioEl.play().catch(() => {});
    // Debug handle for live diagnosis (harmless; not part of any API).
    (window as unknown as Record<string, unknown>).__shemaStream = this;
  }

  private onSourceOpen = (): void => {
    this.hadOpened = true;
    if (!this.mediaSource || this.sourceBuffer) return;
    try {
      const sb = this.mediaSource.addSourceBuffer('audio/mpeg');
      sb.mode = 'sequence'; // concatenate appends back-to-back regardless of timestamps
      sb.addEventListener('updateend', this.flush);
      this.sourceBuffer = sb;
      this.flush();
    } catch (e) {
      console.error('[AudioStream] addSourceBuffer failed:', e);
    }
  };

  /** Enqueue a decoded MP3 chunk for playback, tagged with its sentence seq. */
  appendChunk(bytes: Uint8Array, seq?: number): void {
    if (!this.active || bytes.length === 0) return;
    this.pending.push({ bytes, seq: seq ?? null });
    this.flush();
  }

  private flush = (): void => {
    const sb = this.sourceBuffer;
    if (!sb) return;

    // The previous append has landed — extend its seq's time range to the
    // new buffered end.
    if (!sb.updating && this.lastAppendedSeq !== null) {
      const r = this.seqRanges.get(this.lastAppendedSeq);
      const end = this.bufferedEnd();
      if (r && end !== null && end > r.end) r.end = end;
    }

    // New data has landed since starvation → warm-seek and resume.
    this.maybeResumeFromStarvation();

    if (sb.updating || this.pending.length === 0) return;

    // First append after starvation: remember where the new clip begins
    // (current buffered end) so the resume can target just before it.
    if (this.starved && this.starvedClipStart === null) {
      this.starvedClipStart = this.bufferedEnd() ?? 0;
    }

    const next = this.pending.shift()!;
    if (next.seq !== null && !this.seqRanges.has(next.seq)) {
      const start = this.bufferedEnd() ?? 0;
      this.seqRanges.set(next.seq, { start, end: start });
      // Bound the map: prune entries far behind the playhead.
      if (this.seqRanges.size > 60) {
        const oldest = this.seqRanges.keys().next().value;
        if (oldest !== undefined) this.seqRanges.delete(oldest);
      }
    }
    try {
      sb.appendBuffer(next.bytes as BufferSource);
      if (next.seq !== null) this.lastAppendedSeq = next.seq;
      this.appendFailures = 0;
    } catch (e) {
      if ((e as DOMException)?.name === 'QuotaExceededError') {
        this.evictPlayed();
        this.pending.unshift(next); // retry on next updateend, after eviction frees space
      } else {
        console.error('[AudioStream] appendBuffer failed:', e);
        // A SourceBuffer that keeps rejecting appends is dead — every later
        // chunk would fail too while the page still looks "live".
        if (++this.appendFailures >= 3) this.fatal('appendBuffer failing repeatedly');
      }
    }

    // Resume if the element underran while waiting for data.
    if (!this.starved && this.audioEl && this.audioEl.paused) this.audioEl.play().catch(() => {});
  };

  private bufferedEnd(): number | null {
    const sb = this.sourceBuffer;
    if (!sb || sb.buffered.length === 0) return null;
    return sb.buffered.end(sb.buffered.length - 1);
  }

  /**
   * After starvation, once the incoming clip's data is actually buffered,
   * seek to WARMUP_SEC before the clip start (inside the previous clip's
   * silent tail) and play. Never skips new content — the target is always at
   * or before the new clip's first sample.
   */
  private maybeResumeFromStarvation(): void {
    const el = this.audioEl;
    const sb = this.sourceBuffer;
    if (!el || !sb || sb.updating || !this.starved || this.starvedClipStart === null) return;

    // Right after a warmup resume, a re-starve just plays on — another
    // rewind would replay the onset we just played (audible stutter).
    if (Date.now() - this.lastResumeAt < AudioStreamPlayer.RESUME_COOLDOWN_MS) {
      this.starved = false;
      this.starvedClipStart = null;
      el.play().catch(() => {});
      return;
    }

    const end = this.bufferedEnd();
    if (end === null || end < this.starvedClipStart + AudioStreamPlayer.MIN_AHEAD_SEC) return; // not enough of the new clip yet

    const rangeStart = sb.buffered.start(0);
    const target = Math.max(rangeStart, this.starvedClipStart - AudioStreamPlayer.WARMUP_SEC);
    try {
      el.currentTime = target;
    } catch {
      /* seek can throw during teardown; playback will still resume below */
    }
    el.play().catch(() => {});
    this.lastResumeAt = Date.now();
    this.starved = false;
    this.starvedClipStart = null;
  }

  /** Free SourceBuffer quota by dropping audio that has already played. */
  private evictPlayed(): void {
    const sb = this.sourceBuffer;
    const el = this.audioEl;
    if (!sb || !el || sb.updating || sb.buffered.length === 0) return;
    try {
      const start = sb.buffered.start(0);
      const target = Math.max(start, el.currentTime - 2);
      if (target > start) sb.remove(start, target);
    } catch {
      /* remove can throw if updating; ignore */
    }
  }

  /** New broadcast — clear anything queued; the stream itself continues. */
  reset(): void {
    this.pending = [];
    this.starved = true;
    this.starvedClipStart = null;
    // Seq numbering restarts with the new broadcast; old ranges would
    // mis-attribute the new timeline.
    this.seqRanges.clear();
    this.lastAppendedSeq = null;
    this.lastNotifiedSeq = null;
  }

  stop(): void {
    this.active = false;
    this.pending = [];
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    try {
      if (this.mediaSource && this.mediaSource.readyState === 'open') {
        this.mediaSource.endOfStream();
      }
    } catch {
      /* ignore */
    }
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.removeAttribute('src');
      this.audioEl.load();
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.audioEl = null;
    this.objectUrl = null;
  }

  /** Seconds of audio buffered ahead of the playhead (how far behind live). */
  get backlogSeconds(): number {
    const el = this.audioEl;
    const end = this.bufferedEnd();
    if (!el || end === null) return 0;
    return Math.max(0, end - el.currentTime);
  }

  /**
   * Skip to ~1s behind the freshest buffered audio. Nothing is lost — the
   * transcript keeps every line — the listener just stops hearing old
   * content. Used by the "Jump to live" control when drift runs deep.
   */
  jumpToLive(): void {
    const el = this.audioEl;
    const sb = this.sourceBuffer;
    const end = this.bufferedEnd();
    if (!el || !sb || end === null) return;
    const start = sb.buffered.length > 0 ? sb.buffered.start(sb.buffered.length - 1) : 0;
    try {
      el.currentTime = Math.max(start, end - 1.0);
    } catch {
      /* seek can throw mid-update; the catch-up rate keeps working regardless */
    }
    this.rateTarget = 1.0;
    el.playbackRate = 1.0;
    el.play().catch(() => {});
  }

  /** Output volume, 0–1. Applies immediately and to future start() calls. */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.audioEl) this.audioEl.volume = this.volume;
  }

  /**
   * Mute (the listener's Pause). iOS ignores the `volume` property on media
   * elements, so muting is the only cross-platform silence; the stream keeps
   * flowing so resuming stays near-live. Survives player rebuilds.
   */
  setMuted(m: boolean): void {
    this.muted = m;
    if (this.audioEl) this.audioEl.muted = m;
  }

  /**
   * Route playback to a specific audio OUTPUT device (setSinkId — Chrome/
   * Edge; a no-op where unsupported). Survives player rebuilds. Lets /speak
   * capture from a USB interface while sending translated audio to the
   * headphone jack feeding the church system.
   */
  setSinkId(id: string): void {
    this.sinkId = id;
    const el = this.audioEl as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    el?.setSinkId?.(id).catch((e) => console.warn('[AudioStream] setSinkId failed:', e));
  }

  get isActive(): boolean {
    return this.active;
  }
}

/** Decode a base64 string to bytes (for MP3 chunks arriving over JSON WS). */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
