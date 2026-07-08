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
    this.mediaSource = new MS();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.audioEl.src = this.objectUrl;
    this.mediaSource.addEventListener('sourceopen', this.onSourceOpen);
    this.audioEl.play().catch(() => {});
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
    if (!sb || sb.updating || this.pending.length === 0) return;

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
    if (this.audioEl && this.audioEl.paused) this.audioEl.play().catch(() => {});
  };

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
