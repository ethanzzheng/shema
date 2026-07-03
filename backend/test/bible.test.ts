import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getVerse, getVerseWindow } from '../src/bible';

test('getVerse: known verses hit', () => {
  const john316 = getVerse('John', 3, 16);
  assert.ok(john316 && john316.includes('For God so loved the world'));

  const gen11 = getVerse('Genesis', 1, 1);
  assert.equal(gen11, 'In the beginning God created the heavens and the earth.');
});

test('getVerse: book names normalized to scripture.ts conventions', () => {
  // Dataset says "Psalm" / "Song of Solomon"; we look up by BOOK_MAP names.
  assert.ok(getVerse('Psalms', 23, 1)?.includes('The LORD is my shepherd'));
  assert.ok(getVerse('Song of Songs', 2, 1));
  // numbered books
  assert.ok(getVerse('1 Corinthians', 13, 1));
  assert.ok(getVerse('2 Timothy', 3, 16));
});

test('getVerse: misses return null', () => {
  assert.equal(getVerse('John', 99, 1), null);
  assert.equal(getVerse('John', 3, 999), null);
  assert.equal(getVerse('Gospel of Thomas', 1, 1), null);
});

test('getVerseWindow: target plus following verses', () => {
  const w = getVerseWindow('John', 13, 4, 2);
  assert.equal(w.length, 3);
  assert.deepEqual(
    w.map((x) => x.ref),
    ['John 13:4', 'John 13:5', 'John 13:6'],
  );
  assert.ok(w[0].text.includes('wrapped a towel around His waist'));
});

test('getVerseWindow: clipped at end of chapter', () => {
  // John 3 has 36 verses; window from 36 should return just the one.
  const w = getVerseWindow('John', 3, 36, 2);
  assert.equal(w.length, 1);
  assert.equal(w[0].ref, 'John 3:36');
});

test('getVerseWindow: unknown reference returns empty', () => {
  assert.deepEqual(getVerseWindow('John', 99, 1), []);
});
