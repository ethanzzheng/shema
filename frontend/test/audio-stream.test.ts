/**
 * Regression tests for the listener audio path.
 *
 * The live pilot reported that "nearly every chunk begins with a partial
 * syllable then restarts" — Go- God says… These tests reproduce that from the
 * player's own state machine, headlessly, so the fix can be proven rather than
 * listened for.
 *
 * The invariant under test is the one the product actually needs:
 *   the playhead must never move back into audio the listener already heard.
 * Anything that violates it is heard as a stutter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock, installFakeDom, setSecondsPerByte, FakeAudio, FakeMediaSource } from './fake-media';

/** One byte of "MP3" = this many seconds, so clip sizes are easy to reason about. */
const SEC_PER_BYTE = 0.001; // 1000 bytes = 1 second

interface Sim {
  el: FakeAudio;
  ms: FakeMediaSource;
  clock: VirtualClock;
  player: { appendChunk(b: Uint8Array, seq?: number): void; start(): void; stop(): void };
}

async function makePlayer(): Promise<Sim> {
  const clock = new VirtualClock();
  const created = installFakeDom(clock);
  setSecondsPerByte(SEC_PER_BYTE);
  // Import fresh so module-level browser lookups see the fakes.
  const mod = await import(`../lib/audio-stream?t=${Date.now()}`);
  const player = new mod.AudioStreamPlayer();
  player.start();
  // The element attaches its MediaSource asynchronously in a real browser.
  clock.advance(10, 10);
  created.ms.el = created.el;
  created.el.ms = created.ms;
  created.ms.open();
  clock.advance(10, 10);
  return { el: created.el, ms: created.ms, clock, player };
}

/**
 * Replay a sermon-shaped arrival pattern: sentences separated by gaps long
 * enough to drain the buffer, each delivered as several chunks — exactly the
 * conditions the live service produced.
 */
function playSermon(sim: Sim, sentences: number, opts?: { gapMs?: number; clipSec?: number; chunks?: number }): void {
  // The gap must exceed the clip length, or the buffer never actually drains
  // and the starvation path under test is never entered. Live backend logs
  // showed 2-6s of starvation before nearly every sentence.
  const gapMs = opts?.gapMs ?? 5000;
  const clipSec = opts?.clipSec ?? 3;
  const nChunks = opts?.chunks ?? 6;
  const bytesPerChunk = Math.round((clipSec / nChunks) / SEC_PER_BYTE);
  for (let s = 1; s <= sentences; s++) {
    for (let c = 0; c < nChunks; c++) {
      sim.player.appendChunk(new Uint8Array(bytesPerChunk), s);
      // Chunks of one sentence stream in quickly...
      sim.clock.advance(60, 20, () => sim.el.tick(0.02));
    }
    // ...then the pipeline goes quiet while the next sentence is translated,
    // which is what drains the buffer and triggers starvation.
    sim.clock.advance(gapMs, 20, () => sim.el.tick(0.02));
  }
}

test('playhead never re-enters audio the listener already heard', async () => {
  const sim = await makePlayer();
  playSermon(sim, 12);

  const replays = sim.el.seeks.filter((s) => s.intoPlayed);
  const detail = replays
    .slice(0, 5)
    .map((s) => `  at ${s.at}ms: ${s.from}s -> ${s.to}s (already heard ${sim.el.maxPlayed.toFixed(2)}s)`)
    .join('\n');
  assert.equal(
    replays.length,
    0,
    `playhead was sent back into already-played audio ${replays.length} time(s) — this is the "Go- God says" stutter:\n${detail}`,
  );
});

test('playback still advances (the no-replay fix must not simply stop audio)', async () => {
  const sim = await makePlayer();
  playSermon(sim, 8);
  assert.ok(
    sim.el.maxPlayed > 10,
    `expected well over 10s of audio to have played across 8 sentences, got ${sim.el.maxPlayed.toFixed(2)}s`,
  );
});

test('silence fill keeps the element fed through translation gaps', async () => {
  const sim = await makePlayer();
  playSermon(sim, 6);
  const pads = (sim.player as unknown as { padsAppended: number }).padsAppended;
  assert.ok(pads > 0, 'expected silence pads to be appended during the gaps between sentences');
  // The point of the pads is that the element stops underrunning. Without
  // them each of the 6 gaps underruns; a couple of edge stalls are tolerable.
  const stalls = sim.el.waitingCount;
  assert.ok(stalls <= 2, `expected the fill to prevent most underruns, saw ${stalls} 'waiting' events`);
});

test('silence fill yields to real audio and never delays speech', async () => {
  const sim = await makePlayer();
  // Queue a backlog of real audio; no pad should be appended while it drains.
  for (let i = 0; i < 10; i++) sim.player.appendChunk(new Uint8Array(1000), i + 1);
  sim.clock.advance(2000, 20, () => sim.el.tick(0.02));
  const pads = (sim.player as unknown as { padsAppended: number }).padsAppended;
  assert.equal(pads, 0, `padded while ${10} real chunks were queued — speech would be delayed`);
});

test('a mid-sentence stall does not rewind into the current sentence', async () => {
  const sim = await makePlayer();
  // One long sentence whose chunks arrive with a stall in the middle.
  sim.player.appendChunk(new Uint8Array(2000), 1); // 2s
  sim.clock.advance(2500, 20, () => sim.el.tick(0.02)); // drain past it
  sim.player.appendChunk(new Uint8Array(2000), 1); // rest of the SAME sentence
  sim.clock.advance(1000, 20, () => sim.el.tick(0.02));

  const replays = sim.el.seeks.filter((s) => s.intoPlayed);
  assert.equal(replays.length, 0, `mid-sentence stall replayed audio: ${JSON.stringify(replays)}`);
});

test('silence is never spliced into the middle of a sentence', async () => {
  // Reported from the second live service: audio cut out mid-word ("au--io"),
  // 10-15 times across the sermon. A sentence arrives as many chunks, so
  // between two of them `pending` is momentarily empty — and if the buffered
  // lead is thin at that instant, the fill used to append ~290ms of silence
  // inside a word. Silence is only ever safe BETWEEN sentences.
  const sim = await makePlayer();
  const p = sim.player as unknown as {
    noteClipStart(): void;
    noteClipEnd(): void;
    padsAppended: number;
  };

  // A clip opens and its chunks trickle in with a long jitter gap in between,
  // while the buffer is deliberately kept thin.
  p.noteClipStart();
  sim.player.appendChunk(new Uint8Array(300), 1); // 0.3s, under the 0.4s fill target
  sim.clock.advance(3000, 20, () => sim.el.tick(0.02)); // stall mid-sentence
  const padsMidClip = p.padsAppended;
  assert.equal(padsMidClip, 0, `padded ${padsMidClip} time(s) mid-sentence — this is the mid-word dropout`);

  // Once the sentence finishes, padding the gap before the next one is fine.
  sim.player.appendChunk(new Uint8Array(300), 1);
  p.noteClipEnd();
  sim.clock.advance(3000, 20, () => sim.el.tick(0.02));
  assert.ok(p.padsAppended > 0, 'the fill must still bridge the gap BETWEEN sentences');
});

test('stats() counts a replay, so a regression is visible in a real service', async () => {
  // Instrumentation that can only ever report zero is worse than none: it
  // reads as proof things are fine. Force the exact fault it exists to catch
  // — the playhead moving back into audio already heard — and require the
  // counter to move.
  const sim = await makePlayer();
  playSermon(sim, 3);

  const player = sim.player as unknown as {
    stats(): { replays: number; underruns: number; secondsPlayed: number };
  };
  const before = player.stats();
  assert.equal(before.replays, 0, 'a healthy run must report no replays');
  assert.ok(before.secondsPlayed > 0, 'expected some audio to have played');

  // Drag the playhead back a full second and let timeupdate observe it.
  sim.el.currentTime = Math.max(0, sim.el.currentTime - 1);
  sim.clock.advance(400, 20, () => sim.el.tick(0.02));

  assert.ok(
    player.stats().replays > 0,
    'a backward jump into played audio must be counted, or the metric is blind',
  );
});

test('a lost audio_end must not disable the silence fill for the rest of the service', async () => {
  // The fill is suppressed while a clip is streaming so silence cannot land
  // inside a word. That suppression is a counter, incremented on audio_start
  // and decremented on audio_end — so a single missed audio_end (TTS error
  // mid-clip, a socket blip, a sentence abandoned on stop) pins it above zero
  // and the fill never runs again. Every later sentence then starts on a
  // drained buffer, which is heard as the first word being cut off.
  const sim = await makePlayer();
  const p = sim.player as unknown as {
    noteClipStart(): void;
    noteClipEnd(): void;
    padsAppended: number;
  };

  // Sentence 1 arrives and completes normally.
  p.noteClipStart();
  sim.player.appendChunk(new Uint8Array(1000), 1);
  p.noteClipEnd();
  sim.clock.advance(4000, 20, () => sim.el.tick(0.02));

  // Sentence 2 opens and its audio_end is LOST.
  p.noteClipStart();
  sim.player.appendChunk(new Uint8Array(1000), 2);
  // (no noteClipEnd)
  sim.clock.advance(4000, 20, () => sim.el.tick(0.02));

  const padsBefore = p.padsAppended;
  // Sentence 3 and a realistic gap after it.
  sim.player.appendChunk(new Uint8Array(1000), 3);
  sim.clock.advance(5000, 20, () => sim.el.tick(0.02));

  assert.ok(
    p.padsAppended > padsBefore,
    'the fill stayed dead after one missed audio_end — every later sentence starts on a dry buffer',
  );
});

test('a sentence onset onto a drained buffer gets a silent runway ahead of it', async () => {
  // Defence in depth for the clipped-onset report. When the fill is healthy
  // there is already silence ahead of every sentence and this never fires.
  // It exists for the cases where the fill did NOT run — a clip whose end was
  // lost, or a mobile timer throttled through the gap — because the clips
  // themselves carry a median of only ~52ms of lead-in. On a cold output the
  // resume transient removes the opening word rather than shortening it.
  const sim = await makePlayer();
  const p = sim.player as unknown as {
    noteClipStart(): void;
    padsAppended: number;
    leadIns: number;
  };

  // A clip streams but its audio_end never arrives, so the fill is suppressed
  // and the buffer really does drain — the exact pre-fix failure mode.
  p.noteClipStart();
  sim.player.appendChunk(new Uint8Array(1000), 1); // 1s of audio
  sim.clock.advance(4000, 20, () => sim.el.tick(0.02)); // drains; still under CLIP_STALE_MS

  const before = p.leadIns;
  sim.player.appendChunk(new Uint8Array(1000), 2); // next sentence, onto nothing
  sim.clock.advance(100, 10, () => sim.el.tick(0.02));

  assert.ok(
    p.leadIns > before,
    'the sentence was appended straight onto a drained buffer with no runway ahead of it',
  );
});

test('a backlog is never delayed to insert a runway', async () => {
  // The runway is only for a cold start. When audio is already queued the
  // listener is behind, and inserting silence would push speech further back.
  const sim = await makePlayer();
  const p = sim.player as unknown as { leadIns: number };
  for (let i = 0; i < 10; i++) sim.player.appendChunk(new Uint8Array(1000), i + 1);
  sim.clock.advance(2000, 20, () => sim.el.tick(0.02));
  assert.equal(p.leadIns, 0, 'padded ahead of a backlog — speech would be delayed');
});
