import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { KoreanChunker } from '../src/chunker';

/** Flush pending promise chains (pump() runs async after a timer fires). */
const flush = () => new Promise((r) => setImmediate(r));

function makeChunker(mode: 'fast' | 'smooth' = 'smooth') {
  const dispatched: { text: string; seq: number }[] = [];
  let seq = 0;
  const chunker = new KoreanChunker({
    mode,
    nextSeq: () => ++seq,
    onChunk: async (text, s) => {
      dispatched.push({ text, seq: s });
    },
  });
  return { chunker, dispatched };
}

test('complete sentence dispatches after the short beat', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    await chunker.feed('예수님은 겸손하십니다.', true);

    mock.timers.tick(349);
    await flush();
    assert.equal(dispatched.length, 0, 'must not dispatch before completeMs');

    mock.timers.tick(1);
    await flush();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, '예수님은 겸손하십니다.');
  } finally {
    mock.timers.reset();
  }
});

test('mid-sentence dramatic pauses do NOT cut — fragments merge into one sentence', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');

    // Pastor pauses 2s mid-sentence, twice — under incompleteMaxMs (5s).
    await chunker.feed('십자가는', true);
    mock.timers.tick(2000);
    await flush();
    assert.equal(dispatched.length, 0, 'incomplete fragment must wait');

    await chunker.feed('하나님이 지극히 겸손한 분이라는 것을', true);
    mock.timers.tick(2000);
    await flush();
    assert.equal(dispatched.length, 0, 'still incomplete, still waiting');

    await chunker.feed('입증해 준 겁니다.', true);
    mock.timers.tick(350);
    await flush();

    assert.equal(dispatched.length, 1, 'one merged sentence, not three fragments');
    assert.equal(dispatched[0].text, '십자가는 하나님이 지극히 겸손한 분이라는 것을 입증해 준 겁니다.');
  } finally {
    mock.timers.reset();
  }
});

test('an unfinished thought is force-dispatched only after incompleteMaxMs', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    await chunker.feed('그래서 주님은', true);

    mock.timers.tick(4999);
    await flush();
    assert.equal(dispatched.length, 0);

    mock.timers.tick(1);
    await flush();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, '그래서 주님은');
  } finally {
    mock.timers.reset();
  }
});

test('run-on past maxChars dispatches immediately', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    const long = '가나다라마바사 '.repeat(60); // > 400 chars, no terminator
    await chunker.feed(long, true);
    await flush();
    assert.equal(dispatched.length, 1, 'maxChars cap must dispatch without waiting');
  } finally {
    mock.timers.reset();
  }
});

test('seq is assigned in spoken order and dispatch is serialized in order', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const dispatched: { text: string; seq: number }[] = [];
    let seq = 0;
    const resolvers: (() => void)[] = [];
    const chunker = new KoreanChunker({
      mode: 'smooth',
      nextSeq: () => ++seq,
      // Slow, manually-resolved onChunk to prove serialization.
      onChunk: (text, s) =>
        new Promise<void>((resolve) => {
          dispatched.push({ text, seq: s });
          resolvers.push(resolve);
        }),
    });

    await chunker.feed('첫 번째 문장입니다.', true);
    mock.timers.tick(350);
    await flush();
    await chunker.feed('두 번째 문장입니다.', true);
    mock.timers.tick(350);
    await flush();

    // Second sentence must NOT start until the first resolves.
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0], { text: '첫 번째 문장입니다.', seq: 1 });

    resolvers[0]();
    await flush();
    assert.equal(dispatched.length, 2);
    assert.deepEqual(dispatched[1], { text: '두 번째 문장입니다.', seq: 2 });
    resolvers[1]();
  } finally {
    mock.timers.reset();
  }
});

test('new speech resets the incomplete timer (no premature fragment)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    await chunker.feed('마음을', true);
    mock.timers.tick(4000);
    await flush();
    await chunker.feed('낮추면은', true); // resets the 5s clock
    mock.timers.tick(4000);
    await flush();
    assert.equal(dispatched.length, 0, 'timer must reset on new speech');

    mock.timers.tick(1000);
    await flush();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, '마음을 낮추면은');
  } finally {
    mock.timers.reset();
  }
});
