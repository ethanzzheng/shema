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

test('punctuated complete sentence dispatches immediately', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    await chunker.feed('예수님은 겸손하십니다.', true);
    await flush();
    assert.equal(dispatched.length, 1, 'terminal punctuation = high confidence, no wait');
    assert.equal(dispatched[0].text, '예수님은 겸손하십니다.');
  } finally {
    mock.timers.reset();
  }
});

test('Korean final ending without punctuation dispatches after the short beat', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    await chunker.feed('예수님은 겸손하십니다', true); // no period

    mock.timers.tick(349);
    await flush();
    assert.equal(dispatched.length, 0, 'must not dispatch before completeMs');

    mock.timers.tick(1);
    await flush();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, '예수님은 겸손하십니다');
  } finally {
    mock.timers.reset();
  }
});

test('rapid ramble: interior sentences ship immediately, tail keeps waiting', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    // One Deepgram final containing two finished sentences + an unfinished tail
    // (the exact shape that used to be held hostage during rambles).
    await chunker.feed('첫 번째 문장입니다. 두 번째 문장입니다. 그리고 세 번째', true);
    await flush();

    assert.equal(dispatched.length, 2, 'both complete sentences ship with zero wait');
    assert.equal(dispatched[0].text, '첫 번째 문장입니다.');
    assert.equal(dispatched[1].text, '두 번째 문장입니다.');

    // The tail completes in the next final → assembles and ships.
    await chunker.feed('문장이 끝났습니다.', true);
    await flush();
    assert.equal(dispatched.length, 3);
    assert.equal(dispatched[2].text, '그리고 세 번째 문장이 끝났습니다.');
  } finally {
    mock.timers.reset();
  }
});

test('tiny sentences group up to a minimum size instead of shipping alone', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    await chunker.feed('네. 그렇죠. 하나님은 겸손의 왕이십니다. 다음 이야기가', true);
    await flush();

    // "네. 그렇죠." (7 chars) is under MIN_DISPATCH_CHARS → keeps grouping until
    // the third sentence pushes the group over the minimum. Ships as one chunk.
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, '네. 그렇죠. 하나님은 겸손의 왕이십니다.');
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

test('a normal-length unfinished thought force-dispatches after incompleteMaxMs', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    // ≥ TINY_FRAGMENT_CHARS and no final ending → the standard 5s patience.
    const text = '우리가 하나님의 은혜와 사랑을 늘 기억하면서 그리고';
    await chunker.feed(text, true);

    mock.timers.tick(4999);
    await flush();
    assert.equal(dispatched.length, 0);

    mock.timers.tick(1);
    await flush();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, text);
  } finally {
    mock.timers.reset();
  }
});

test('graded patience: a tiny shard waits 2x incompleteMaxMs before force-shipping', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    await chunker.feed('그리고 금요일에', true); // < TINY_FRAGMENT_CHARS, incomplete

    mock.timers.tick(9999);
    await flush();
    assert.equal(dispatched.length, 0, 'tiny shard must wait the doubled timeout');

    mock.timers.tick(1);
    await flush();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, '그리고 금요일에');
  } finally {
    mock.timers.reset();
  }
});

test('graded patience: the continuation arrives during the extended hold and merges', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    await chunker.feed('그리고 금요일에', true);

    // 7s pause — past the old 5s cutoff that used to ship the dangler.
    mock.timers.tick(7000);
    await flush();
    assert.equal(dispatched.length, 0);

    await chunker.feed('목장에 우선순위를 두는 것입니다.', true);
    await flush();
    assert.equal(dispatched.length, 1, 'shard merges with its continuation');
    assert.equal(dispatched[0].text, '그리고 금요일에 목장에 우선순위를 두는 것입니다.');
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

test('seq in spoken order; up to 2 translations overlap; 3rd waits for a slot', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const started: { text: string; seq: number }[] = [];
    let seq = 0;
    const resolvers: (() => void)[] = [];
    const chunker = new KoreanChunker({
      mode: 'smooth',
      nextSeq: () => ++seq,
      // Slow, manually-resolved onChunk to observe in-flight behavior.
      onChunk: (text, s) =>
        new Promise<void>((resolve) => {
          started.push({ text, seq: s });
          resolvers.push(resolve);
        }),
    });

    for (const t of ['첫 번째 문장입니다.', '두 번째 문장입니다.', '세 번째 문장입니다.']) {
      await chunker.feed(t, true);
      mock.timers.tick(350);
      await flush();
    }

    // First two start immediately (bounded parallelism = 2), in spoken order.
    assert.equal(started.length, 2);
    assert.deepEqual(started[0], { text: '첫 번째 문장입니다.', seq: 1 });
    assert.deepEqual(started[1], { text: '두 번째 문장입니다.', seq: 2 });

    // Third must wait until a slot frees.
    resolvers[0]();
    await flush();
    assert.equal(started.length, 3);
    assert.deepEqual(started[2], { text: '세 번째 문장입니다.', seq: 3 });
    resolvers[1]();
    resolvers[2]();
  } finally {
    mock.timers.reset();
  }
});

test('interim results re-arm the timer: no force-ship while speech is flowing', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    await chunker.feed('십자가는', true); // incomplete tail, 5s clock starts

    // Deepgram keeps the continuation as interims for a while — the speaker is
    // audibly mid-sentence, so the fragment must NOT ship on the original clock.
    // ('십자가는' is tiny → graded patience gives it the doubled 10s timeout.)
    mock.timers.tick(9000);
    await chunker.feed('하나님이 지극히', false); // interim: speech ongoing
    mock.timers.tick(9000); // 18s total, but only 9s since last speech evidence
    await flush();
    assert.equal(dispatched.length, 0, 'interim must re-arm the incomplete timer');

    // True silence after the interim → fragment ships as a last resort.
    mock.timers.tick(1000);
    await flush();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, '십자가는', 'interim text itself is never buffered');
  } finally {
    mock.timers.reset();
  }
});

test('duplicated STT final: re-sent overlap is trimmed, not translated twice', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    // Deepgram emits a clause as a final, then re-sends it at the head of the
    // next final (observed live: the clause got doubled and translated twice).
    await chunker.feed('하나님과 이웃을 향한 사랑이 있는지', true);
    await chunker.feed('하나님과 이웃을 향한 사랑이 있는지 우리는 확인해야 합니다.', true);
    await flush();

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, '하나님과 이웃을 향한 사랑이 있는지 우리는 확인해야 합니다.');
  } finally {
    mock.timers.reset();
  }
});

test('a final that is a pure duplicate of the buffer is ignored', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    await chunker.feed('우리의 삶 속에 성령의 열매가', true);
    await chunker.feed('우리의 삶 속에 성령의 열매가', true); // exact re-send
    await chunker.feed('있는지 확인해야 합니다.', true);
    await flush();

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, '우리의 삶 속에 성령의 열매가 있는지 확인해야 합니다.');
  } finally {
    mock.timers.reset();
  }
});

test('short coincidental overlaps are NOT trimmed', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    // "은혜" legitimately ends one clause and begins the next — 2 chars is far
    // below MIN_STT_OVERLAP_CHARS, so nothing may be trimmed.
    await chunker.feed('우리가 받은 것은 은혜', true);
    await chunker.feed('은혜 위에 은혜입니다.', true);
    await flush();

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, '우리가 받은 것은 은혜 은혜 위에 은혜입니다.');
  } finally {
    mock.timers.reset();
  }
});

test('new speech resets the incomplete timer (no premature fragment)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('smooth');
    // Tiny buffers get the doubled (10s) graded-patience timeout throughout.
    await chunker.feed('마음을', true);
    mock.timers.tick(9000);
    await flush();
    await chunker.feed('낮추면은', true); // resets the clock
    mock.timers.tick(9000);
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

test('hold cap: endless interims cannot stall audio forever', async () => {
  // Interims re-arm the incomplete timer so it measures real silence rather
  // than Deepgram's finalization lag. Without a ceiling, a pastor who never
  // pauses would hold the buffer until maxChars (~35s of speech), so the cap
  // is what makes that re-arm safe to rely on.
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { chunker, dispatched } = makeChunker('smooth'); // maxHoldMs 14000
  try {
    await chunker.feed('예수 그리스도의 교회, 자기 피로 사신 교회를', true);
    // Speech keeps flowing: an interim every second, forever.
    for (let i = 0; i < 20; i++) {
      mock.timers.tick(1000);
      await flush();
      await chunker.feed('계속 말씀하시는 중', false);
    }
    await flush();
    assert.ok(
      dispatched.length > 0,
      'buffer was never dispatched — endless interims held the audio indefinitely',
    );
  } finally {
    mock.timers.reset();
  }
});

test('a dangling clause is held longer than a merely abrupt one', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { chunker, dispatched } = makeChunker('smooth'); // incompleteMaxMs 5000
  try {
    // Ends on an object particle: the head noun has not been spoken yet.
    await chunker.feed('예수 그리스도의 교회, 자기 피로 사신 교회를', true);
    mock.timers.tick(5200); // past the ordinary incomplete timeout
    await flush();
    assert.equal(dispatched.length, 0, 'a dangling clause must not ship at the ordinary timeout');
    mock.timers.tick(5000); // into the doubled patience
    await flush();
    assert.ok(dispatched.length > 0, 'it must still ship eventually');
  } finally {
    mock.timers.reset();
  }
});

test('VALIDATION: the church/self-centeredness sentence is never split before its head noun', async () => {
  // This is the sentence that produced the theological inversion at the live
  // pilot. Korean puts the object and its modifiers BEFORE the head noun, so
  // cutting after 교회를 stranded the modifiers and English attached them to
  // the previous sentence, reading as though Christ's sacrifice were the
  // self-centeredness. Taken verbatim from the recorded service.
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { chunker, dispatched } = makeChunker('smooth');
  try {
    // Arrives the way Deepgram delivered it: the object first, then a pause,
    // then the modifier chain and finally the head noun.
    await chunker.feed('예수 그리스도의 교회를 예수님께서 핏값을 주고 사신 그 교회를', true);
    // 6s is PAST the ordinary incomplete timeout (5s in smooth), so unfixed
    // code would have force-shipped the object phrase here. The dangling-head
    // patience is the only thing holding it.
    mock.timers.tick(6000);
    await flush();
    assert.equal(
      dispatched.length,
      0,
      `shipped an object phrase with no head noun: ${JSON.stringify(dispatched.map((d) => d.text))}`,
    );

    await chunker.feed('자기의 것으로 만들어 버리려고 하는 그 지독한 자기 중심성,', true);
    mock.timers.tick(6000);
    await flush();
    assert.equal(dispatched.length, 0, 'a comma-terminated noun phrase is still mid-thought');

    // The predicate finally arrives and the whole thought ships together.
    await chunker.feed('그것이 교회를 무너뜨립니다.', true);
    mock.timers.tick(1000);
    await flush();
    assert.ok(dispatched.length > 0, 'the completed sentence must ship');
    const all = dispatched.map((d) => d.text).join(' ');
    const headIdx = all.indexOf('자기 중심성');
    const objIdx = all.indexOf('교회를');
    assert.ok(headIdx > -1 && objIdx > -1, 'both the object and its head noun must be present');
    // The object and the head noun it belongs to must land in the SAME chunk.
    const chunkWithObject = dispatched.find((d) => d.text.includes('교회를'))!;
    assert.ok(
      chunkWithObject.text.includes('자기 중심성'),
      `object and head noun were split across chunks — the inversion can recur:\n${JSON.stringify(dispatched.map((d) => d.text), null, 2)}`,
    );
  } finally {
    mock.timers.reset();
  }
});

test('CONTROL: a grammatically complete sentence still ships promptly', async () => {
  // Guards the tests above from passing for the wrong reason: if the chunker
  // simply never dispatched, they would both pass while the product was broken.
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { chunker, dispatched } = makeChunker('smooth');
  try {
    await chunker.feed('우리는 하나님을 사랑해야 합니다.', true);
    mock.timers.tick(600); // just past completeMs (350)
    await flush();
    assert.ok(dispatched.length > 0, 'a complete sentence must not be delayed by the dangling rules');
  } finally {
    mock.timers.reset();
  }
});

test('VALIDATION: a scripture citation is held until its verse number arrives', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { chunker, dispatched } = makeChunker('smooth');
  try {
    // Long enough to clear TINY_FRAGMENT_CHARS, so the short-shard patience
    // is not what holds it — only the incomplete-reference rule is.
    await chunker.feed('같이 한 목소리로 다 함께 큰 소리로 읽으시겠습니다 베드로 후서 한 장', true);
    mock.timers.tick(7000); // past incompleteMaxMs (5s in smooth)
    await flush();
    const shippedIncomplete = dispatched.some(
      (d) => /한 장\s*$/.test(d.text.trim()),
    );
    assert.equal(shippedIncomplete, false, 'shipped "2 Peter chapter 1" with no verse number');
  } finally {
    mock.timers.reset();
  }
});

test('REGRESSION: the closing-prayer sentence does not fragment', async () => {
  // "Father God, through the fragrance of someone who remembers us," came out
  // as a fragment in two consecutive runs. The Korean ends on 통하여서 — a
  // connective with the main verb still to come.
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { chunker, dispatched } = makeChunker('smooth');
  try {
    await chunker.feed('하나님 아버지, 저희를 기억하는 그 누군가가 저희 향기를 통하여서', true);
    mock.timers.tick(6000); // past the ordinary incomplete timeout
    await flush();
    assert.equal(
      dispatched.length,
      0,
      `shipped the prayer opening with no main verb: ${JSON.stringify(dispatched.map((d) => d.text))}`,
    );
    await chunker.feed('그 사랑을 기억할 수 있기를 원합니다.', true);
    mock.timers.tick(1000);
    await flush();
    assert.ok(dispatched.length > 0, 'the completed prayer must ship');
    assert.ok(
      dispatched[0].text.includes('통하여서') && dispatched[0].text.includes('원합니다'),
      `the clause and its verb must land together: ${dispatched[0].text}`,
    );
  } finally {
    mock.timers.reset();
  }
});
