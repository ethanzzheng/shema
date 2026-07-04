import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderedEmitter } from '../src/ordered-emitter';

function make() {
  const emitted: number[] = [];
  const em = new OrderedEmitter<number>((n) => emitted.push(n));
  return { em, emitted };
}

test('in-order completions emit immediately', () => {
  const { em, emitted } = make();
  em.anchor(1);
  em.finish(1, 1);
  em.anchor(2);
  em.finish(2, 2);
  assert.deepEqual(emitted, [1, 2]);
});

test('out-of-order completion is held until its turn', () => {
  const { em, emitted } = make();
  em.anchor(1);
  em.anchor(2);
  em.finish(2, 2); // seq 2 finishes first (faster translation)
  assert.deepEqual(emitted, [], 'seq 2 must wait for seq 1');
  em.finish(1, 1);
  assert.deepEqual(emitted, [1, 2], 'both emit, in spoken order');
});

test('a failed seq is skipped without stalling later seqs', () => {
  const { em, emitted } = make();
  em.anchor(1);
  em.anchor(2);
  em.anchor(3);
  em.finish(3, 3);
  em.finish(1, 1);
  assert.deepEqual(emitted, [1], 'seq 3 still waits on seq 2');
  em.finish(2, null); // seq 2 failed → skip
  assert.deepEqual(emitted, [1, 3]);
});

test('anchor starts at the first dispatched seq (not 1)', () => {
  const { em, emitted } = make();
  // second broadcast in a session: seq continues from e.g. 51
  em.anchor(51);
  em.finish(51, 51);
  assert.deepEqual(emitted, [51]);
});

test('reset clears state for a new session', () => {
  const { em, emitted } = make();
  em.anchor(1);
  em.finish(2, 2); // stale out-of-order completion
  em.reset();
  em.anchor(10);
  em.finish(10, 10);
  assert.deepEqual(emitted, [10], 'stale parked seq must not emit after reset');
});
