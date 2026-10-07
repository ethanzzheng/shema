/**
 * The transcript writer sits beside the live translation path, so the
 * properties under test are mostly about what it must NOT do: never wait on
 * the database, never throw into the pipeline, never grow without bound when
 * the database is failing, and never lose spoken order.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { TranscriptWriter, TranscriptIO, Pending } from '../src/transcripts/writer';

function recorder(opts: { fail?: number; delayMs?: number } = {}) {
  const batches: Pending[][] = [];
  let completed = 0;
  let remainingFailures = opts.fail ?? 0;
  const io: TranscriptIO = {
    async insert(_id, batch) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (remainingFailures > 0) {
        remainingFailures--;
        throw new Error('database unavailable');
      }
      batches.push(batch);
    },
    async complete() {
      completed++;
    },
  };
  return {
    io,
    batches,
    get completed() { return completed; },
    get written() { return batches.flat(); },
  };
}

const seg = (seq: number, t = 0) => ({
  seq,
  sourceText: `source ${seq}`,
  sermon: `sermon ${seq}`,
  direct: `direct ${seq}`,
  lang: 'en',
  timestampMs: t,
});

describe('TranscriptWriter', () => {
  test('add() returns without waiting on the database', async () => {
    // The whole point: this is called from the live emission path, between a
    // translation landing and its audio being queued.
    const r = recorder({ delayMs: 500 });
    const w = new TranscriptWriter('t1', 0, 'hanmaum', r.io);
    const started = Date.now();
    for (let i = 1; i <= 10; i++) w.add(seg(i));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 50, `add() blocked for ${elapsed}ms — this would be sermon latency`);
    await w.close();
  });

  test('flushes once a batch has built up', async () => {
    const r = recorder();
    const w = new TranscriptWriter('t1', 0, 'hanmaum', r.io);
    for (let i = 1; i <= 10; i++) w.add(seg(i));
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(r.batches.length, 1, 'expected one flush at the batch threshold');
    assert.equal(r.written.length, 10);
    await w.close();
  });

  test('close() flushes a partial batch and marks the transcript complete', async () => {
    const r = recorder();
    const w = new TranscriptWriter('t1', 0, 'hanmaum', r.io);
    w.add(seg(1));
    w.add(seg(2));
    assert.equal(r.written.length, 0, 'a partial batch should still be waiting');
    await w.close();
    assert.equal(r.written.length, 2, 'close() must not lose the tail of a sermon');
    assert.equal(r.completed, 1);
  });

  test('offsets are relative to the start of the broadcast', async () => {
    const r = recorder();
    const w = new TranscriptWriter('t1', 1_000_000, 'hanmaum', r.io);
    w.add(seg(1, 1_000_000)); // the very first moment
    w.add(seg(2, 1_012_500)); // 12.5s later
    await w.close();
    assert.equal(r.written[0].offsetMs, 0);
    assert.equal(r.written[1].offsetMs, 12_500);
  });

  test('both renderings are kept, keyed by output language', async () => {
    const r = recorder();
    const w = new TranscriptWriter('t1', 0, 'hanmaum', r.io);
    w.add(seg(1));
    await w.close();
    assert.deepEqual(r.written[0].translations, {
      en: { sermon: 'sermon 1', direct: 'direct 1' },
    });
  });

  test('a failed flush retries without reordering the sermon', async () => {
    const r = recorder({ fail: 1 });
    const w = new TranscriptWriter('t1', 0, 'hanmaum', r.io);
    for (let i = 1; i <= 10; i++) w.add(seg(i));
    await new Promise((res) => setTimeout(res, 20));
    for (let i = 11; i <= 20; i++) w.add(seg(i));
    await w.close();
    const seqs = r.written.map((s) => s.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), `segments landed out of order: ${seqs}`);
    assert.equal(seqs.length, 20, 'a transient failure must not drop segments');
  });

  test('a database that keeps failing is given up on, not buffered forever', async () => {
    // A broadcaster must not run out of memory because Postgres is down; the
    // transcript is the acceptable loss here, the service is not.
    const r = recorder({ fail: 999 });
    const w = new TranscriptWriter('t1', 0, 'hanmaum', r.io);
    for (let i = 1; i <= 200; i++) w.add(seg(i));
    await new Promise((res) => setTimeout(res, 50));
    const s = w.stats();
    assert.ok(s.stopped, 'the writer should have given up after repeated failures');
    assert.ok(s.buffered < 200, `still buffering ${s.buffered} segments while the database is down`);
    await w.close();
  });

  test('add() after the writer has given up is a no-op, not a throw', async () => {
    const r = recorder({ fail: 999 });
    const w = new TranscriptWriter('t1', 0, 'hanmaum', r.io);
    for (let i = 1; i <= 200; i++) w.add(seg(i));
    await new Promise((res) => setTimeout(res, 50));
    assert.doesNotThrow(() => w.add(seg(999)), 'a dead writer must never throw into the pipeline');
    await w.close();
  });
});
