import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getVerseKo, getVerseWindowKo } from '../src/bible';
import { BOOK_MAP } from '../src/scripture';

test('getVerseKo: known verses hit with 개역한글 wording', () => {
  const john316 = getVerseKo('John', 3, 16);
  // 저를/멸망치 is the KRV (개역한글) reading — distinguishes it from 개역개정.
  assert.ok(john316 && john316.includes('독생자') && john316.includes('저를 믿는 자마다'));

  assert.equal(getVerseKo('Genesis', 1, 1), '태초에 하나님이 천지를 창조하시니라!');
});

test('getVerseKo: keyed by the English names both detectors produce', () => {
  assert.ok(getVerseKo('Psalms', 23, 1)?.includes('여호와는 나의 목자'));
  assert.ok(getVerseKo('Song of Songs', 2, 1));
  assert.ok(getVerseKo('1 Corinthians', 13, 1));
  assert.ok(getVerseKo('2 Timothy', 3, 16));
});

test('getVerseKo: every BOOK_MAP book exists in the Korean dataset', () => {
  for (const en of new Set(Object.values(BOOK_MAP))) {
    assert.ok(getVerseKo(en, 1, 1), `missing Korean text for ${en} 1:1`);
  }
});

test('getVerseKo: Psalm superscriptions are stripped from verse 1', () => {
  assert.ok(!getVerseKo('Psalms', 23, 1)!.startsWith('('));
  assert.ok(!getVerseKo('Psalms', 51, 1)!.startsWith('('));
});

test('getVerseKo: misses return null', () => {
  assert.equal(getVerseKo('John', 99, 1), null);
  assert.equal(getVerseKo('John', 3, 999), null);
  assert.equal(getVerseKo('Gospel of Thomas', 1, 1), null);
});

test('getVerseWindowKo: target plus following verses, clipped at chapter end', () => {
  const w = getVerseWindowKo('John', 3, 16, 2);
  assert.equal(w.length, 3);
  assert.deepEqual(
    w.map((x) => x.ref),
    ['John 3:16', 'John 3:17', 'John 3:18'],
  );

  const end = getVerseWindowKo('John', 3, 36, 2);
  assert.equal(end.length, 1);
  assert.equal(end[0].ref, 'John 3:36');

  assert.deepEqual(getVerseWindowKo('John', 99, 1), []);
});
