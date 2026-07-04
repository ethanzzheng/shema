/**
 * Re-orders out-of-order completions back into sequence order.
 *
 * The chunker allows a bounded number of translations in flight, so they can
 * finish out of spoken order. Each completion is parked here; `emit` is called
 * strictly in seq order, as soon as every earlier seq has finished. A failed
 * seq is parked as `null` and skipped, so one failure never stalls the stream.
 *
 * `anchor(seq)` must be called when a seq is DISPATCHED (dispatch happens in
 * spoken order) so the emitter knows where the sequence starts.
 */
export class OrderedEmitter<T> {
  private nextSeq: number | null = null;
  private parked = new Map<number, T | null>();

  constructor(private emit: (job: T) => void) {}

  /** Note a dispatched seq; the first one anchors the sequence start. */
  anchor(seq: number): void {
    if (this.nextSeq === null) this.nextSeq = seq;
  }

  /** Park a completion (or `null` for a failure) and emit everything now ready. */
  finish(seq: number, job: T | null): void {
    this.parked.set(seq, job);
    if (this.nextSeq === null) return;
    while (this.parked.has(this.nextSeq)) {
      const next = this.parked.get(this.nextSeq)!;
      this.parked.delete(this.nextSeq);
      this.nextSeq++;
      if (next !== null) this.emit(next);
    }
  }

  /** Reset for a new session. */
  reset(): void {
    this.nextSeq = null;
    this.parked.clear();
  }
}
