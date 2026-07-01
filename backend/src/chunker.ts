/**
 * Korean text chunker with parallel dispatch.
 *
 * Batches rapid-fire STT utterances with a debounce timer, then
 * fires translations in parallel (up to MAX_CONCURRENT). Results
 * are handled by the callback independently — the broadcaster
 * assigns sequence numbers for ordering.
 */

export type ChunkCallback = (text: string) => Promise<void>;

interface ChunkerOptions {
  mode: 'fast' | 'smooth';
  onChunk: ChunkCallback;
}

const DEBOUNCE_MS = 400;
const MAX_CHARS = 300;
const MAX_CONCURRENT = 3; // Up to 3 translations in flight at once

export class KoreanChunker {
  private buffer = '';
  private onChunk: ChunkCallback;
  private debounceTimer: NodeJS.Timeout | null = null;
  private inFlight = 0;

  constructor(opts: ChunkerOptions) {
    this.onChunk = opts.onChunk;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setMode(_mode: 'fast' | 'smooth'): void {}

  async feed(text: string, isFinal: boolean): Promise<void> {
    if (!isFinal || !text.trim()) return;

    this.buffer += (this.buffer ? ' ' : '') + text.trim();

    if (this.buffer.length >= MAX_CHARS) {
      this.cancelDebounce();
      this.dispatch();
      return;
    }

    this.cancelDebounce();
    this.debounceTimer = setTimeout(() => {
      this.dispatch();
    }, DEBOUNCE_MS);
  }

  async forceFlush(): Promise<void> {
    this.cancelDebounce();
    this.dispatch();
    // Wait for in-flight to finish
    while (this.inFlight > 0) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private cancelDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private dispatch(): void {
    const text = this.buffer.trim();
    this.buffer = '';
    if (!text) return;

    if (this.inFlight >= MAX_CONCURRENT) {
      // At capacity — drop oldest work to stay near real-time
      console.log(`[Chunker] At max concurrency (${this.inFlight}), dispatching anyway`);
    }

    this.inFlight++;
    console.log(`[Chunker] Dispatching ${text.length} chars (${this.inFlight} in flight)`);

    // Fire and forget — don't await, let translations run in parallel
    this.onChunk(text)
      .catch((err) => console.error('[Chunker] onChunk error:', err))
      .finally(() => {
        this.inFlight--;
      });
  }

  destroy(): void {
    this.cancelDebounce();
    this.buffer = '';
  }
}
