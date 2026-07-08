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
  private pending: Uint8Array[] = [];
  private active = false;
  private volume = 1;

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
    this.mediaSource = new MS();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.audioEl.src = this.objectUrl;
    this.mediaSource.addEventListener('sourceopen', this.onSourceOpen);
    this.audioEl.play().catch(() => {});
    // Debug handle for live diagnosis (harmless; not part of any API).
    (window as unknown as Record<string, unknown>).__shemaStream = this;
  }

  private onSourceOpen = (): void => {
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

  /** Enqueue a decoded MP3 chunk for playback. */
  appendChunk(bytes: Uint8Array): void {
    if (!this.active || bytes.length === 0) return;
    this.pending.push(bytes);
    this.flush();
  }

  private flush = (): void => {
    const sb = this.sourceBuffer;
    if (!sb) return;

    // New data has landed since starvation → warm-seek and resume.
    this.maybeResumeFromStarvation();

    if (sb.updating || this.pending.length === 0) return;

    // First append after starvation: remember where the new clip begins
    // (current buffered end) so the resume can target just before it.
    if (this.starved && this.starvedClipStart === null) {
      this.starvedClipStart = this.bufferedEnd() ?? 0;
    }

    const next = this.pending.shift()!;
    try {
      sb.appendBuffer(next as BufferSource);
    } catch (e) {
      if ((e as DOMException)?.name === 'QuotaExceededError') {
        this.evictPlayed();
        this.pending.unshift(next); // retry on next updateend, after eviction frees space
      } else {
        console.error('[AudioStream] appendBuffer failed:', e);
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
  }

  stop(): void {
    this.active = false;
    this.pending = [];
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

  /** Output volume, 0–1. Applies immediately and to future start() calls. */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.audioEl) this.audioEl.volume = this.volume;
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
