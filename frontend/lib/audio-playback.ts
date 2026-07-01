/**
 * Sequential MP3 audio playback queue.
 *
 * Receives base64-encoded MP3 chunks with sequence numbers,
 * decodes them via Web Audio API, and plays them in order with
 * no gaps and no overlaps.
 *
 * DROP policy: if the queue grows beyond MAX_QUEUE_SIZE, old items
 * are dropped to stay near-live.
 */

const MAX_QUEUE_SIZE = 4; // Drop if queue is this deep

interface QueueItem {
  seq: number;
  buffer: AudioBuffer;
}

export class AudioPlaybackQueue {
  private ctx: AudioContext | null = null;
  private queue: QueueItem[] = [];
  private playing = false;
  private nextPlayAt = 0; // audioCtx.currentTime when next clip should start
  private active = false;

  start(): void {
    this.active = true;
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    this.nextPlayAt = this.ctx.currentTime;
  }

  stop(): void {
    this.active = false;
    this.queue = [];
    this.playing = false;
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }

  /**
   * Enqueue a base64-encoded MP3 chunk.
   * The seq number is used for diagnostic ordering (we trust server ordering).
   */
  async enqueue(seq: number, base64Mp3: string): Promise<void> {
    if (!this.active || !this.ctx) return;

    try {
      const binary = atob(base64Mp3);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const audioBuffer = await this.ctx.decodeAudioData(bytes.buffer.slice(0));

      // Drop policy: if queue is too full, discard old items to stay live
      if (this.queue.length >= MAX_QUEUE_SIZE) {
        console.warn(`[Playback] Queue overflow (${this.queue.length}); dropping old items`);
        this.queue = this.queue.slice(-1); // keep only the newest
        // Reset nextPlayAt to now so we don't schedule far in future
        this.nextPlayAt = this.ctx.currentTime;
      }

      this.queue.push({ seq, buffer: audioBuffer });
      this.drainQueue();
    } catch (err) {
      console.error('[Playback] Decode error:', err);
    }
  }

  private drainQueue(): void {
    if (!this.active || !this.ctx || this.queue.length === 0) return;

    // Schedule all queued items back-to-back
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      const startAt = Math.max(this.nextPlayAt, this.ctx.currentTime);

      const source = this.ctx.createBufferSource();
      source.buffer = item.buffer;
      source.connect(this.ctx.destination);
      source.start(startAt);

      this.nextPlayAt = startAt + item.buffer.duration;
      this.playing = true;

      source.onended = () => {
        if (this.queue.length === 0) this.playing = false;
      };
    }
  }

  get isPlaying(): boolean {
    return this.playing;
  }
}
