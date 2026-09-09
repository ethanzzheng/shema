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
