/**
 * Local Bible verse lookup — English (Berean Standard Bible, public domain)
 * and Korean (개역한글 KRV, public domain; see data/README.md).
 *
 * Both datasets load once at module init and are keyed by the ENGLISH book
 * names the reference detectors produce (`BOOK_MAP` values), so a detected
 * `ScriptureRef` works against either. Used to inject canonical verse text
 * into the translation prompts so quoted scripture comes from a real source
 * instead of model memory.
 *
 * Swap translations with env vars pointing at same-shape JSON files:
 *   BIBLE_DATA_PATH    — English (e.g. a licensed NIV dataset)
 *   BIBLE_DATA_PATH_KO — Korean (e.g. a licensed 개역개정 dataset)
 */

import * as fs from 'fs';
import * as path from 'path';

type BibleData = Record<string, Record<string, Record<string, string>>>;

function loadBible(dataPath: string, label: string): BibleData {
  try {
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as BibleData;
    console.log(`[Bible] Loaded ${Object.keys(data).length} ${label} books from ${path.basename(dataPath)}`);
    return data;
  } catch (err) {
    console.error(`[Bible] Failed to load ${dataPath} — ${label} verse lookup disabled:`, (err as Error).message);
    return {};
  }
}

const bible = loadBible(
  process.env.BIBLE_DATA_PATH || path.join(__dirname, '..', 'data', 'bsb.json'),
  'English',
);
const bibleKo = loadBible(
  process.env.BIBLE_DATA_PATH_KO || path.join(__dirname, '..', 'data', 'krv.json'),
  'Korean',
);

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

/** Exact KOREAN (개역한글) verse text, or null if absent from the dataset. */
export function getVerseKo(book: string, chapter: number, verse: number): string | null {
  return bibleKo[book]?.[String(chapter)]?.[String(verse)] ?? null;
}

/** Korean counterpart of getVerseWindow (refs stay in English for keying). */
export function getVerseWindowKo(
  book: string,
  chapter: number,
  verse: number,
  after = 2,
): { ref: string; text: string }[] {
  const out: { ref: string; text: string }[] = [];
  for (let v = verse; v <= verse + after; v++) {
    const text = getVerseKo(book, chapter, v);
    if (text) out.push({ ref: `${book} ${chapter}:${v}`, text });
  }
  return out;
}
