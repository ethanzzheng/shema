/**
 * Direction-based boundary selection in the chunker. The Korean behavior is
 * pinned by chunker.test.ts (unchanged); this file covers the en-ko detector
 * and the longer en-ko waiting windows.
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { KoreanChunker } from '../src/chunker';

const flush = () => new Promise((r) => setImmediate(r));

function makeChunker(direction: 'ko-en' | 'en-ko', mode: 'fast' | 'smooth' = 'smooth') {
  const dispatched: { text: string; seq: number }[] = [];
  let seq = 0;
  const chunker = new KoreanChunker({
    mode,
    direction,
    nextSeq: () => ++seq,
    onChunk: async (text, s) => {
      dispatched.push({ text, seq: s });
    },
  });
  return { chunker, dispatched };
}

test('en-ko: punctuated complete English sentences dispatch immediately', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('en-ko');
    await chunker.feed('God is good all the time. And when we look at', true);
    await flush();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, 'God is good all the time.');
  } finally {
    mock.timers.reset();
  }
});

test('en-ko: an abbreviation period does not dispatch a cut sentence', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('en-ko');
    await chunker.feed('We met Dr. Kim at church. He prayed.', true);
    await flush();
    assert.equal(dispatched.length, 2, 'split after Kim and prayed, never after Dr.');
    assert.equal(dispatched[0].text, 'We met Dr. Kim at church.');
    assert.equal(dispatched[1].text, 'He prayed.');
  } finally {
    mock.timers.reset();
  }
});

test('en-ko: punctuated mid-clause cut ("...and.") waits and merges with its continuation', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('en-ko');
    // Deepgram punctuates the dramatic pause — but the clause is not done.
    await chunker.feed('He took the loaves and.', true);
    mock.timers.tick(2000);
    await flush();
    assert.equal(dispatched.length, 0, 'trailing connective vetoes the period');

    await chunker.feed('He gave thanks to God.', true);
    await flush();
    assert.equal(dispatched.length, 1, 'cut clause merges instead of shipping alone');
    assert.equal(dispatched[0].text, 'He took the loaves and. He gave thanks to God.');
  } finally {
    mock.timers.reset();
  }
});

test('en-ko: unpunctuated fragment force-ships only after the LONGER en-ko window', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('en-ko');
    // ≥ TINY_FRAGMENT_CHARS, ends on a connective → standard incomplete wait,
    // which for en-ko smooth is 6000ms (vs 5000ms for ko-en).
    const text = 'because the Lord was leading them into';
    await chunker.feed(text, true);

    mock.timers.tick(5999);
    await flush();
    assert.equal(dispatched.length, 0, 'must outwait the ko-en window — en-ko waits longer');

    mock.timers.tick(1);
    await flush();
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].text, text);
  } finally {
    mock.timers.reset();
  }
});

test('direction selection: the same unpunctuated Korean text behaves per-direction', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // ko-en: Korean final ending → grammatically complete → short 350ms beat.
    const ko = makeChunker('ko-en');
    await ko.chunker.feed('예수님은 겸손하십니다', true);
    mock.timers.tick(350);
    await flush();
    assert.equal(ko.dispatched.length, 1, 'Korean detector reads the final ending');

    // en-ko: no punctuation → not confident → still holding at 350ms.
    const en = makeChunker('en-ko');
    await en.chunker.feed('예수님은 겸손하십니다', true);
    mock.timers.tick(350);
    await flush();
    assert.equal(en.dispatched.length, 0, 'English detector needs punctuation');
  } finally {
    mock.timers.reset();
  }
});

test('en-ko: run-on past the larger en-ko maxChars dispatches immediately', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('en-ko');
    const long = 'walking in the light of '.repeat(25); // 600 chars > 520, no terminator
    await chunker.feed(long, true);
    await flush();
    assert.equal(dispatched.length, 1, 'maxChars cap must dispatch without waiting');
  } finally {
    mock.timers.reset();
  }
});

test('en-ko: continuous comma-chained preaching dispatches via clause relief, no timers', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { chunker, dispatched } = makeChunker('en-ko');
    // Polysyndetic run-on: no periods at all, clauses chained with commas —
    // the live 40s-gap shape. Must ship clause chunks WITHOUT any timer tick.
    await chunker.feed('And God spoke to his people in the wilderness, and he led them by day with a cloud', true);
    await chunker.feed('and by night with a pillar of fire, and he fed them with manna from heaven', true);
    await chunker.feed('and gave them water from the rock, and still they doubted him in their hearts', true);
    await flush();

    assert.ok(dispatched.length >= 1, 'clause relief must dispatch before any pause');
    assert.ok(
      dispatched[0].text.endsWith(','),
      `head must end at a clause boundary, got: ${dispatched[0].text}`,
    );
    assert.ok(dispatched[0].text.length >= 40, 'head must be a real clause, not a stub');
  } finally {
    mock.timers.reset();
  }
});

test('default direction is ko-en (constructor omits direction)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const dispatched: string[] = [];
    let seq = 0;
    const chunker = new KoreanChunker({
      mode: 'smooth',
      nextSeq: () => ++seq,
      onChunk: async (text) => {
        dispatched.push(text);
      },
    });
    await chunker.feed('하나님은 겸손의 왕이십니다', true); // Korean final ending, no punct
    mock.timers.tick(350);
    await flush();
    assert.equal(dispatched.length, 1, 'Korean completeMs path proves the ko-en default');
  } finally {
    mock.timers.reset();
  }
});
