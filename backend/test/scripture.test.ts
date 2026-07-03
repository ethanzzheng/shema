import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKoreanNumber,
  detectReference,
  mergeReference,
  formatReference,
  ScriptureRef,
} from '../src/scripture';

test('parseKoreanNumber: Sino-Korean', () => {
  assert.equal(parseKoreanNumber('일'), 1);
  assert.equal(parseKoreanNumber('십'), 10);
  assert.equal(parseKoreanNumber('십삼'), 13);
  assert.equal(parseKoreanNumber('이 십 육'), 26);
  assert.equal(parseKoreanNumber('오 십 삼'), 53);
  assert.equal(parseKoreanNumber('백 십 육'), 116);
  assert.equal(parseKoreanNumber('육'), 6);
  assert.equal(parseKoreanNumber('륙'), 6);
});

test('parseKoreanNumber: native Korean', () => {
  assert.equal(parseKoreanNumber('한'), 1);
  assert.equal(parseKoreanNumber('두'), 2);
  assert.equal(parseKoreanNumber('열'), 10);
  assert.equal(parseKoreanNumber('열세'), 13);
  assert.equal(parseKoreanNumber('열 세'), 13);
  assert.equal(parseKoreanNumber('스물여섯'), 26);
  assert.equal(parseKoreanNumber('서른'), 30);
});

test('parseKoreanNumber: Arabic digits', () => {
  assert.equal(parseKoreanNumber('13'), 13);
  assert.equal(parseKoreanNumber('4'), 4);
});

test('parseKoreanNumber: garbage returns null', () => {
  assert.equal(parseKoreanNumber(''), null);
  assert.equal(parseKoreanNumber('안녕'), null);
  assert.equal(parseKoreanNumber('열혹'), null);
});

test('detectReference: book + chapter in one segment', () => {
  assert.deepEqual(detectReference('빌립보서 두 장.'), { book: 'Philippians', chapter: 2 });
  assert.deepEqual(detectReference('성경 고린도전서 일 장.'), { book: '1 Corinthians', chapter: 1 });
  assert.deepEqual(detectReference('요한복음 열 세 장'), { book: 'John', chapter: 13 });
  assert.deepEqual(detectReference('마태복음 이 십 일 장 사 절'), { book: 'Matthew', chapter: 21, verse: 4 });
});

test('detectReference: lone verse segment', () => {
  assert.deepEqual(detectReference('오 절.'), { verse: 5 });
  assert.deepEqual(detectReference('이 십 육 절'), { verse: 26 });
});

test('detectReference: no reference returns null', () => {
  assert.equal(detectReference('예수님이 겸손하시다는 증거가 십자가입니다'), null);
  assert.equal(detectReference(''), null);
});

test('detectReference: longest book name wins (예레미야애가 vs 예레미야)', () => {
  assert.equal(detectReference('예레미야애가 삼 장')?.book, 'Lamentations');
  assert.equal(detectReference('예레미야 일 장')?.book, 'Jeremiah');
});

test('mergeReference: chapter/verse accumulate within a book', () => {
  let cur: ScriptureRef | null = null;
  cur = mergeReference(cur, { book: 'Philippians', chapter: 2 });
  cur = mergeReference(cur, { verse: 5 });
  assert.equal(formatReference(cur), 'Philippians 2:5');
});

test('mergeReference: new book resets chapter and verse', () => {
  let cur: ScriptureRef | null = { book: 'Philippians', chapter: 2, verse: 5 };
  cur = mergeReference(cur, { book: '1 Corinthians', chapter: 1 });
  assert.equal(formatReference(cur), '1 Corinthians 1');
  assert.equal(cur.verse, undefined);
});

test('mergeReference: new chapter clears stale verse', () => {
  let cur: ScriptureRef | null = { book: 'John', chapter: 13, verse: 4 };
  cur = mergeReference(cur, { chapter: 14 });
  assert.equal(formatReference(cur), 'John 14');
});

test('formatReference shapes', () => {
  assert.equal(formatReference(null), null);
  assert.equal(formatReference({ chapter: 3 }), null); // no book → nothing to anchor
  assert.equal(formatReference({ book: 'Isaiah' }), 'Isaiah');
  assert.equal(formatReference({ book: 'Isaiah', chapter: 53 }), 'Isaiah 53');
  assert.equal(formatReference({ book: 'Isaiah', chapter: 53, verse: 2 }), 'Isaiah 53:2');
});
