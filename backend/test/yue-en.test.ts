/**
 * Cantonese (yue-en) and the completeness check shared by the Chinese
 * directions: script folding, Cantonese boundary rules, Cantonese scripture
 * references, the oracle's reply parsing, and how the chunker acts on it.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { foldToSimplified } from '../src/zh-script';
import { looksCompleteYue, endsDanglingYue, splitLastClauseYue } from '../src/text-yue';
import { detectReferenceZh } from '../src/scripture-zh';
import { parseVerdict, type OracleVerdict } from '../src/boundary-oracle';
import { KoreanChunker } from '../src/chunker';
import { SYSTEM_PROMPT_YUE_EN, SYSTEM_PROMPT_KO_EN, backlogHint } from '../src/translation';
import { normalizeDirection, getDirectionConfig } from '../src/direction-config';

const flush = () => new Promise((r) => setImmediate(r));

test('folding is length-preserving and leaves Simplified alone', () => {
  const t = '因為你說羅馬書十三章嘅時候，我們這個會';
  assert.equal(foldToSimplified(t), '因为你说罗马书十三章嘅时候，我们这个会');
  assert.equal(foldToSimplified(t).length, t.length);
  assert.equal(foldToSimplified('我们一起来祷告'), '我们一起来祷告');
});

test('Cantonese particles close a sentence', () => {
  for (const t of ['我哋要好好咁聽佢講啦', '神真係好愛你㗎', '佢話佢唔嚟喎', '係咁嘅']) {
    assert.equal(looksCompleteYue(t), true, t);
  }
});

test('Cantonese and Traditional dangling endings hold', () => {
  for (const t of ['因為你知道神係', '所以你的態度應該是很好因為', '我哋喺', '呢個', '佢哋嘅', '你可能']) {
    assert.equal(endsDanglingYue(t), true, t);
    assert.equal(looksCompleteYue(t), false, t);
  }
});

test('ordinary words that end like a dangling one do not hold', () => {
  for (const t of ['佢哋嘅關係', '呢個係唔同', '好重要', '有可能']) {
    assert.equal(endsDanglingYue(t), false, t);
  }
});

test('Cantonese clause split cuts before an opener and keeps offsets', () => {
  const t = '如果他們想做什麼一定要聽這不是說我們要同意每一樣東西不過有一個智慧可以控制';
  const s = splitLastClauseYue(t);
  assert.ok(s);
  assert.equal(s.head + s.rest, t);
  assert.ok(s.rest.startsWith('不過'));
});

test('Cantonese references: Traditional book names, 至 ranges, 廿', () => {
  assert.deepEqual(detectReferenceZh('羅馬書十三章一至二節'), { book: 'Romans', chapter: 13, verse: 1 });
  assert.deepEqual(detectReferenceZh('廿八節'), { verse: 28 });
  assert.deepEqual(detectReferenceZh('約翰福音第三章十六節'), { book: 'John', chapter: 3, verse: 16 });
  // Mandarin unchanged.
  assert.deepEqual(detectReferenceZh('约翰福音3章16节'), { book: 'John', chapter: 3, verse: 16 });
});

test('yue-en is a direction of its own with a Cantonese prompt', () => {
  assert.equal(normalizeDirection('yue-en'), 'yue-en');
  assert.equal(getDirectionConfig('yue-en').sttLanguage, 'zh-HK');
  assert.match(SYSTEM_PROMPT_YUE_EN, /Hong Kong way/);
  assert.doesNotMatch(SYSTEM_PROMPT_YUE_EN, /pinyin in Chinese order/);
  // Korean's prompt carries no Chinese pacing rule.
  assert.doesNotMatch(SYSTEM_PROMPT_KO_EN, /PACE/);
});

test('backlog hint: silent when on time, stronger when far behind', () => {
  assert.equal(backlogHint(undefined), '');
  assert.equal(backlogHint(4), '');
  assert.match(backlogHint(8), /about 8 seconds behind.*shortest faithful/s);
  assert.match(backlogHint(15), /Condense this segment hard/);
});

test('oracle replies map onto the buffer', () => {
  const buf = '我们要彼此相爱因为神先爱我们所以';
  assert.deepEqual(parseVerdict('{"complete":true}', buf), { complete: true });
  assert.deepEqual(parseVerdict('{"complete":false}', buf), { complete: false });
  assert.deepEqual(parseVerdict('{"complete":false,"cut_after":"神先爱我们"}', buf), { complete: false, headLen: 14 });
  // A cut at the very end means complete; a cut that is not in the buffer means none.
  assert.deepEqual(parseVerdict('{"complete":false,"cut_after":"们所以"}', buf), { complete: true });
  assert.deepEqual(parseVerdict('{"complete":false,"cut_after":"不在这里"}', buf), { complete: false });
  assert.equal(parseVerdict('sorry', buf), null);
});

function chineseChunker(direction: 'zh-en' | 'yue-en', verdict: (b: string) => OracleVerdict | null) {
  const dispatched: string[] = [];
  let seq = 0;
  const asked: string[] = [];
  const chunker = new KoreanChunker({
    mode: 'smooth',
    direction,
    nextSeq: () => ++seq,
    onChunk: async (text) => {
      dispatched.push(text);
    },
    oracle: async (b) => {
      asked.push(b);
      return verdict(b);
    },
  });
  return { chunker, dispatched, asked };
}

test('oracle: a complete verdict ships after the short beat, not the long wait', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const { chunker, dispatched } = chineseChunker('zh-en', () => ({ complete: true }));
    await chunker.feed('我们今天看到神的爱何等长阔高深', true);
    await flush();
    await flush();
    assert.equal(dispatched.length, 0);
    mock.timers.tick(400);
    await flush();
    assert.deepEqual(dispatched, ['我们今天看到神的爱何等长阔高深']);
  } finally {
    mock.timers.reset();
  }
});

test('oracle: a complete thought inside the buffer ships now, the rest waits', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const buf = '我們今日睇到神嘅愛何等長闊高深跟住保羅就話';
    const { chunker, dispatched } = chineseChunker('yue-en', () => ({ complete: false, headLen: 15 }));
    await chunker.feed(buf, true);
    await flush();
    await flush();
    assert.deepEqual(dispatched, ['我們今日睇到神嘅愛何等長闊高深']);
  } finally {
    mock.timers.reset();
  }
});

test('oracle: a stale verdict is ignored once more speech arrives', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    let release: (v: OracleVerdict) => void = () => {};
    const dispatched: string[] = [];
    let seq = 0;
    const chunker = new KoreanChunker({
      mode: 'smooth',
      direction: 'zh-en',
      nextSeq: () => ++seq,
      onChunk: async (t) => {
        dispatched.push(t);
      },
      oracle: () => new Promise((r) => (release = r)),
    });
    await chunker.feed('我们今天看到神的爱何等', true);
    await chunker.feed('长阔高深远超过我们所想', true);
    release({ complete: true }); // judged the first buffer only
    await flush();
    mock.timers.tick(400);
    await flush();
    assert.equal(dispatched.length, 0);
  } finally {
    mock.timers.reset();
  }
});
