import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TtsPipeline } from '../src/tts-pipeline';

/** Flush pending promise chains. */
const flush = () => new Promise((r) => setImmediate(r));

interface Job {
  seq: number;
  text: string;
}

/** Pipeline with manually-driven fake synthesis, recording every emission. */
function makePipeline(prefetch = 2) {
  const events: string[] = [];
  const synths: {
    text: string;
    onChunk: (c: Buffer) => void;
    resolve: () => void;
    reject: (e: Error) => void;
  }[] = [];

  const pipeline = new TtsPipeline<Job>({
    prefetch,
    synth: (text, onChunk) =>
      new Promise<void>((resolve, reject) => {
        synths.push({ text, onChunk, resolve, reject });
      }),
    onStart: (j) => events.push(`start:${j.seq}`),
    onChunk: (j, c) => events.push(`chunk:${j.seq}:${c.toString()}`),
    onEnd: (j) => events.push(`end:${j.seq}`),
    onError: (j) => events.push(`error:${j.seq}`),
  });

  return { pipeline, events, synths };
}

test('head clip streams live: start, chunks as they arrive, end', async () => {
  const { pipeline, events, synths } = makePipeline();
  pipeline.enqueue({ seq: 1, text: 'one' });

  assert.equal(synths.length, 1);
  assert.deepEqual(events, ['start:1']);

  synths[0].onChunk(Buffer.from('a'));
  synths[0].onChunk(Buffer.from('b'));
  assert.deepEqual(events, ['start:1', 'chunk:1:a', 'chunk:1:b']);

  synths[0].resolve();
  await flush();
  assert.deepEqual(events, ['start:1', 'chunk:1:a', 'chunk:1:b', 'end:1']);
});

test('next clip synthesises DURING the head clip, but emits only after it', async () => {
  const { pipeline, events, synths } = makePipeline();
  pipeline.enqueue({ seq: 1, text: 'one' });
  pipeline.enqueue({ seq: 2, text: 'two' });

  // Both synthesise concurrently — this overlap is the whole point.
  assert.equal(synths.length, 2, 'clip 2 synthesis must start while clip 1 streams');

  // Clip 2 audio arrives early: buffered, nothing emitted for it yet.
  synths[1].onChunk(Buffer.from('x'));
  synths[0].onChunk(Buffer.from('a'));
  assert.deepEqual(events, ['start:1', 'chunk:1:a']);

  // Clip 1 finishes → clip 2 becomes head and its buffered audio flushes instantly.
  synths[0].resolve();
  await flush();
  assert.deepEqual(events, ['start:1', 'chunk:1:a', 'end:1', 'start:2', 'chunk:2:x']);

  synths[1].onChunk(Buffer.from('y')); // now live
  synths[1].resolve();
  await flush();
  assert.deepEqual(events, ['start:1', 'chunk:1:a', 'end:1', 'start:2', 'chunk:2:x', 'chunk:2:y', 'end:2']);
});

test('prefetch cap: a third clip waits for a synthesis slot', async () => {
  const { pipeline, synths } = makePipeline(2);
  pipeline.enqueue({ seq: 1, text: 'one' });
  pipeline.enqueue({ seq: 2, text: 'two' });
  pipeline.enqueue({ seq: 3, text: 'three' });

  assert.equal(synths.length, 2, 'only prefetch=2 synths in flight');

  synths[0].resolve();
  await flush();
  assert.equal(synths.length, 3, 'slot freed, third synthesis starts');
});

test('a clip that finishes before becoming head flushes fully on promotion', async () => {
  const { pipeline, events, synths } = makePipeline();
  pipeline.enqueue({ seq: 1, text: 'one' });
  pipeline.enqueue({ seq: 2, text: 'two' });

  synths[1].onChunk(Buffer.from('x'));
  synths[1].resolve(); // clip 2 fully done while clip 1 still streaming
  await flush();
  assert.ok(!events.includes('end:2'), 'clip 2 must wait for clip 1');

  synths[0].resolve();
  await flush();
  assert.deepEqual(events, ['start:1', 'end:1', 'start:2', 'chunk:2:x', 'end:2']);
});

test('failure before any audio retries once, silently', async () => {
  const { pipeline, events, synths } = makePipeline();
  pipeline.enqueue({ seq: 1, text: 'one' });

  synths[0].reject(new Error('boom'));
  await flush();

  assert.equal(synths.length, 2, 'must retry the synthesis');
  assert.ok(!events.includes('error:1'), 'retryable failure is not surfaced');

  synths[1].onChunk(Buffer.from('a'));
  synths[1].resolve();
  await flush();
  assert.deepEqual(events, ['start:1', 'chunk:1:a', 'end:1']);
});

test('failure after partial audio does NOT retry (no duplicates) and the line moves on', async () => {
  const { pipeline, events, synths } = makePipeline();
  pipeline.enqueue({ seq: 1, text: 'one' });
  pipeline.enqueue({ seq: 2, text: 'two' });

  synths[0].onChunk(Buffer.from('a'));
  synths[0].reject(new Error('mid-stream drop'));
  await flush();

  assert.equal(synths.length, 2, 'no retry after audio was already forwarded');
  assert.deepEqual(events, ['start:1', 'chunk:1:a', 'error:1', 'end:1', 'start:2']);

  synths[1].resolve();
  await flush();
  assert.deepEqual(events, ['start:1', 'chunk:1:a', 'error:1', 'end:1', 'start:2', 'end:2']);
});
