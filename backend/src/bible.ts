/**
 * Local Bible verse lookup (Berean Standard Bible — public domain).
 *
 * Loads the bundled `data/bsb.json` once at module init. Book names in the
 * dataset are pre-normalized to exactly match the English names produced by
 * `scripture.ts` (`BOOK_MAP` values), so a detected `ScriptureRef` can be used
 * directly. Used to inject canonical verse text into the translation prompt so
 * quoted scripture comes from a real source instead of model memory.
 *
 * Override the data file with the BIBLE_DATA_PATH env var (same JSON shape) to
 * swap translations, e.g. a licensed NIV dataset.
 */

import * as fs from 'fs';
import * as path from 'path';

type BibleData = Record<string, Record<string, Record<string, string>>>;

const DATA_PATH =
  process.env.BIBLE_DATA_PATH || path.join(__dirname, '..', 'data', 'bsb.json');

let bible: BibleData = {};
try {
  bible = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) as BibleData;
  console.log(`[Bible] Loaded ${Object.keys(bible).length} books from ${path.basename(DATA_PATH)}`);
} catch (err) {
  console.error(`[Bible] Failed to load ${DATA_PATH} — verse lookup disabled:`, (err as Error).message);
}

/** Exact verse text, or null if the reference doesn't exist in the dataset. */
export function getVerse(book: string, chapter: number, verse: number): string | null {
  return bible[book]?.[String(chapter)]?.[String(verse)] ?? null;
}

/**
 * The target verse plus the next `after` verses (a reading progresses across
 * segments, so the continuation is usually the following verse or two).
 * Verses past the end of the chapter are simply omitted.
 */
export function getVerseWindow(
  book: string,
  chapter: number,
  verse: number,
  after = 2,
): { ref: string; text: string }[] {
  const out: { ref: string; text: string }[] = [];
  for (let v = verse; v <= verse + after; v++) {
    const text = getVerse(book, chapter, v);
    if (text) out.push({ ref: `${book} ${chapter}:${v}`, text });
  }
  return out;
}
