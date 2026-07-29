import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnglishNumber,
  detectReferenceEn,
  formatReferenceKorean,
  koreanBookName,
} from '../src/scripture-en';
import { mergeReference, ScriptureRef } from '../src/scripture';

test('parseEnglishNumber: digits', () => {
  assert.equal(parseEnglishNumber('13'), 13);
  assert.equal(parseEnglishNumber('4'), 4);
  assert.equal(parseEnglishNumber('119'), 119);
});

test('parseEnglishNumber: number words', () => {
  assert.equal(parseEnglishNumber('one'), 1);
  assert.equal(parseEnglishNumber('thirteen'), 13);
  assert.equal(parseEnglishNumber('twenty three'), 23);
  assert.equal(parseEnglishNumber('twenty-three'), 23);
  assert.equal(parseEnglishNumber('ninety'), 90);
  assert.equal(parseEnglishNumber('one hundred nineteen'), 119);
  assert.equal(parseEnglishNumber('a hundred and five'), 105);
});

test('parseEnglishNumber: garbage returns null', () => {
  assert.equal(parseEnglishNumber(''), null);
  assert.equal(parseEnglishNumber('grace'), null);
  assert.equal(parseEnglishNumber('twenty grace'), null);
});

test('detectReferenceEn: colon form', () => {
  assert.deepEqual(detectReferenceEn('Turn with me to John 3:16.'), { book: 'John', chapter: 3, verse: 16 });
  assert.deepEqual(detectReferenceEn('1 Corinthians 13:4 says'), { book: '1 Corinthians', chapter: 13, verse: 4 });
});

test('detectReferenceEn: chapter/verse words', () => {
  assert.deepEqual(detectReferenceEn('John chapter 3 verse 16'), { book: 'John', chapter: 3, verse: 16 });
  assert.deepEqual(detectReferenceEn('Matthew chapter twenty one, verse four'), { book: 'Matthew', chapter: 21, verse: 4 });
});

test('detectReferenceEn: ordinal-word books', () => {
  assert.deepEqual(detectReferenceEn('First Corinthians 13'), { book: '1 Corinthians', chapter: 13 });
  assert.deepEqual(detectReferenceEn('Second Timothy chapter 2'), { book: '2 Timothy', chapter: 2 });
});

test('detectReferenceEn: book + bare chapter, and aliases', () => {
  assert.deepEqual(detectReferenceEn('Philippians 2'), { book: 'Philippians', chapter: 2 });
  assert.deepEqual(detectReferenceEn('Psalm 23 is our text today.'), { book: 'Psalms', chapter: 23 });
  assert.equal(detectReferenceEn('the book of Revelations tells us')?.book, 'Revelation');
});

test('detectReferenceEn: lone verse/chapter segments (merged by caller)', () => {
  assert.deepEqual(detectReferenceEn('Now look at verse five.'), { verse: 5 });
  assert.deepEqual(detectReferenceEn('and in chapter 14 we read'), { chapter: 14 });
});

test('detectReferenceEn: numbered epistles beat the bare name', () => {
  assert.deepEqual(detectReferenceEn('1 John 4:8'), { book: '1 John', chapter: 4, verse: 8 });
  assert.deepEqual(detectReferenceEn('Third John verse 2'), { book: '3 John', verse: 2 });
});

test('detectReferenceEn: given-name books need evidence (person vs. book)', () => {
  // The person — no reference detected.
  assert.equal(detectReferenceEn('John said to Jesus, where are you going?'), null);
  assert.equal(detectReferenceEn('James was a fisherman like his brother.'), null);
  assert.equal(detectReferenceEn('Job lost everything he had.'), null);
  // The book — number after, or "gospel/book of" before.
  assert.equal(detectReferenceEn('the gospel of John tells us')?.book, 'John');
  assert.equal(detectReferenceEn('the book of Job wrestles with suffering')?.book, 'Job');
  assert.equal(detectReferenceEn('James 1 says count it all joy')?.book, 'James');
});

test('detectReferenceEn: no reference returns null', () => {
  assert.equal(detectReferenceEn('God so loved the world.'), null);
  assert.equal(detectReferenceEn(''), null);
});

test('detectReferenceEn: merges with mergeReference across segments', () => {
  let cur: ScriptureRef | null = null;
  cur = mergeReference(cur, detectReferenceEn('Turn to Philippians chapter 2')!);
  cur = mergeReference(cur, detectReferenceEn('look at verse 5')!);
  assert.deepEqual(cur, { book: 'Philippians', chapter: 2, verse: 5 });
});

test('koreanBookName: reuses the inverted scripture.ts map', () => {
  assert.equal(koreanBookName('Genesis'), '창세기');
  assert.equal(koreanBookName('John'), '요한복음');
  assert.equal(koreanBookName('1 Corinthians'), '고린도전서');
  assert.equal(koreanBookName('Revelation'), '요한계시록');
  assert.equal(koreanBookName('NotABook'), null);
});

test('formatReferenceKorean shapes', () => {
  assert.equal(formatReferenceKorean(null), null);
  assert.equal(formatReferenceKorean({ chapter: 3 }), null); // no book → nothing to cite
  assert.equal(formatReferenceKorean({ book: 'John', chapter: 3, verse: 16 }), '요한복음 3장 16절');
  assert.equal(formatReferenceKorean({ book: 'Philippians', chapter: 2 }), '빌립보서 2장');
  assert.equal(formatReferenceKorean({ book: 'Isaiah' }), '이사야');
});

test('formatReferenceKorean: Psalms uses 편, not 장', () => {
  assert.equal(formatReferenceKorean({ book: 'Psalms', chapter: 23 }), '시편 23편');
  assert.equal(formatReferenceKorean({ book: 'Psalms', chapter: 119, verse: 105 }), '시편 119편 105절');
});
