/**
 * A minimal but faithful model of the browser media stack, enough to exercise
 * AudioStreamPlayer's buffering/resume state machine headlessly.
 *
 * Only the behaviours the player actually depends on are modelled, but the one
 * that matters most is modelled deliberately and explicitly:
 *
 *   A MediaSource-backed element that underruns is NOT paused — it is
 *   buffering. The browser resumes playback on its own as soon as appended
 *   data extends past the playhead.
 *
 * That single rule is what the stutter bug races against, so the simulation is
 * only meaningful because it reproduces it. Everything advances on a virtual
 * clock, so a 47-minute service replays in milliseconds and results are
 * deterministic.
 */

type Listener = () => void;

class Emitter {
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener): void {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  emit(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
}

export class FakeTimeRanges {
  constructor(private ranges: { start: number; end: number }[]) {}
  get length(): number {
    return this.ranges.length;
  }
  start(i: number): number {
    return this.ranges[i].start;
  }
  end(i: number): number {
    return this.ranges[i].end;
  }
}

/** Seconds of audio a byte of our test MP3 represents (set per test). */
export let SECONDS_PER_BYTE = 1 / 16000;
export function setSecondsPerByte(v: number): void {
  SECONDS_PER_BYTE = v;
}

export class FakeSourceBuffer extends Emitter {
  mode = 'segments';
  updating = false;
  bufferedEndSec = 0;
  bufferedStartSec = 0;
  private ms: FakeMediaSource;
  constructor(ms: FakeMediaSource) {
    super();
    this.ms = ms;
  }
  get buffered(): FakeTimeRanges {
    if (this.bufferedEndSec <= this.bufferedStartSec) return new FakeTimeRanges([]);
    return new FakeTimeRanges([{ start: this.bufferedStartSec, end: this.bufferedEndSec }]);
  }
  appendBuffer(bytes: Uint8Array): void {
    if (this.updating) throw new Error('InvalidStateError: updating');
    this.updating = true;
    // Appends land on the next clock tick, like a real async append.
    this.ms.clock.schedule(0, () => {
      this.bufferedEndSec += bytes.length * SECONDS_PER_BYTE;
      this.updating = false;
      this.emit('updateend');
      this.ms.el?.maybeAutoResume();
    });
  }
  remove(start: number, end: number): void {
    this.bufferedStartSec = Math.max(this.bufferedStartSec, Math.min(end, this.bufferedEndSec));
    void start;
  }
}

export class FakeMediaSource extends Emitter {
  static isTypeSupported(): boolean {
    return true;
  }
  readyState: 'closed' | 'open' | 'ended' = 'closed';
  sourceBuffers: FakeSourceBuffer[] = [];
  el: FakeAudio | null = null;
  clock!: VirtualClock;
  addSourceBuffer(_type: string): FakeSourceBuffer {
    const sb = new FakeSourceBuffer(this);
    this.sourceBuffers.push(sb);
    return sb;
  }
  endOfStream(): void {
    this.readyState = 'ended';
  }
  open(): void {
    this.readyState = 'open';
    this.emit('sourceopen');
  }
}

export class FakeAudio extends Emitter {
  autoplay = false;
  volume = 1;
  muted = false;
  playbackRate = 1;
  preservesPitch = true;
  playsInline = false;
  error: { code: number; message: string } | null = null;
  paused = true;
  /** Set when the element ran out of data and is waiting for more. */
  stalled = false;
  /** How many times the element underran (each is an audible gap risk). */
  waitingCount = 0;
  private _currentTime = 0;
  /** Highest position actually rendered to the listener's ear. */
  maxPlayed = 0;
  /** Every assignment to currentTime, with whether it moved backwards. */
  seeks: { at: number; from: number; to: number; backward: boolean; intoPlayed: boolean }[] = [];
  ms: FakeMediaSource | null = null;
  clock!: VirtualClock;

  set currentTime(v: number) {
    const from = this._currentTime;
    const backward = v < from - 1e-6;
    // "Into played" is the one that is actually audible as a stutter: the
    // listener already heard up to maxPlayed, and we are sending the playhead
    // back before it, so that audio plays a second time.
    const intoPlayed = v < this.maxPlayed - 1e-6;
    this.seeks.push({ at: this.clock.now(), from: +from.toFixed(4), to: +v.toFixed(4), backward, intoPlayed });
    this._currentTime = v;
  }
  get currentTime(): number {
    return this._currentTime;
  }
  get buffered(): FakeTimeRanges {
    const sb = this.ms?.sourceBuffers[0];
    return sb ? sb.buffered : new FakeTimeRanges([]);
  }
  setSinkId(): Promise<void> {
    return Promise.resolve();
  }
  setAttribute(): void {}
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  load(): void {}

  /** The browser's own resume: data arrived past the playhead, so play on. */
  maybeAutoResume(): void {
    if (!this.stalled) return;
    const sb = this.ms?.sourceBuffers[0];
    if (!sb) return;
    if (sb.bufferedEndSec > this._currentTime + 1e-9 && !this.paused) {
      this.stalled = false;
      this.emit('playing');
    }
  }

  /** Advance playback by dt seconds of wall time. */
  tick(dt: number): void {
    if (this.paused) return;
    const sb = this.ms?.sourceBuffers[0];
    if (!sb) return;
    const avail = sb.bufferedEndSec - this._currentTime;
    if (avail <= 1e-9) {
      if (!this.stalled) {
        this.stalled = true;
        this.waitingCount++;
        this.emit('waiting');
      }
      return;
    }
    const want = dt * this.playbackRate;
    const move = Math.min(want, avail);
    this._currentTime += move;
    if (this._currentTime > this.maxPlayed) this.maxPlayed = this._currentTime;
    this.emit('timeupdate');
    if (move < want && !this.stalled) {
      this.stalled = true;
      this.waitingCount++;
      this.emit('waiting');
    }
  }
}

interface Scheduled {
  at: number;
  fn: () => void;
  id: number;
  cleared?: boolean;
}

export class VirtualClock {
  private t = 0;
  private q: Scheduled[] = [];
  private nextId = 1;
  now(): number {
    return this.t;
  }
  schedule(delayMs: number, fn: () => void): number {
    const id = this.nextId++;
    this.q.push({ at: this.t + delayMs, fn, id });
    return id;
  }
  clear(id: number): void {
    const s = this.q.find((x) => x.id === id);
    if (s) s.cleared = true;
  }
  /** Run every callback due at or before t. */
  private drain(): void {
    for (;;) {
      const due = this.q.filter((s) => !s.cleared && s.at <= this.t).sort((a, b) => a.at - b.at);
      if (!due.length) return;
      const s = due[0];
      this.q = this.q.filter((x) => x !== s);
      s.fn();
    }
  }
  advance(ms: number, stepMs: number, onStep?: (t: number) => void): void {
    const end = this.t + ms;
    while (this.t < end) {
      const step = Math.min(stepMs, end - this.t);
      this.t += step;
      this.drain();
      onStep?.(this.t);
    }
  }
}

/** Install fake window/document/Audio/MediaSource globals for one test. */
export function installFakeDom(clock: VirtualClock): { el: FakeAudio; ms: FakeMediaSource } {
  const created: { el: FakeAudio | null; ms: FakeMediaSource | null } = { el: null, ms: null };
  const g = globalThis as unknown as Record<string, unknown>;

  class AudioCtor extends FakeAudio {
    constructor() {
      super();
      this.clock = clock;
      created.el = this;
    }
  }
  class MSCtor extends FakeMediaSource {
    constructor() {
      super();
      this.clock = clock;
      created.ms = this;
    }
  }

  // Date.now() must follow the virtual clock too. The player gates its resume
  // on a 500ms real-time cooldown; without this the whole sermon replays
  // inside a few real milliseconds, the cooldown swallows every rewind, and
  // the simulation silently reports a clean run on genuinely broken code.
  const realNow = Date.now.bind(Date);
  const base = realNow();
  Date.now = () => base + clock.now();

  g.Audio = AudioCtor;
  g.MediaSource = MSCtor;
  g.window = { MediaSource: MSCtor };
  g.document = { visibilityState: 'visible', hidden: false };
  g.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
  g.setTimeout = ((fn: () => void, ms: number) => clock.schedule(ms ?? 0, fn)) as unknown;
  g.clearTimeout = ((id: number) => clock.clear(id)) as unknown;
  g.setInterval = ((fn: () => void, ms: number) => {
    const rearm = (): void => {
      fn();
      clock.schedule(ms, rearm);
    };
    return clock.schedule(ms, rearm);
  }) as unknown;
  g.clearInterval = ((id: number) => clock.clear(id)) as unknown;

  return created as { el: FakeAudio; ms: FakeMediaSource };
}
