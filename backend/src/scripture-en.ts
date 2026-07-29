/**
 * Bible-reference detection for spoken ENGLISH sermon text (en-ko direction),
 * plus Korean rendering of references for the en-ko translator prompt.
 *
 * Mirrors scripture.ts (the Korean detector) without touching it. The book
 * data is REUSED by inverting scripture.ts's BOOK_MAP — one source of truth.
 * Returned refs use the same ScriptureRef shape (English book names), so
 * mergeReference and the bible.ts verse lookup work unchanged.
 *
 * Spoken forms handled: "John 3:16", "John chapter 3 verse 16",
 * "First Corinthians 13", "Psalm 23", a lone "verse 5" / "chapter 14"
 * (merged across segments by the caller, like the Korean detector).
 * Numbers may be digits (Deepgram smart_format's usual output) or spelled
 * words ("chapter twenty three").
 */

import { BOOK_MAP, ScriptureRef } from './scripture';

// English book name → Korean (개역 standard), inverted from BOOK_MAP.
const BOOK_EN_TO_KO: Record<string, string> = {};
for (const [kr, en] of Object.entries(BOOK_MAP)) BOOK_EN_TO_KO[en] = kr;

/** The Korean (개역) name of an English book, or null if unknown. */
export function koreanBookName(englishBook: string): string | null {
  return BOOK_EN_TO_KO[englishBook] ?? null;
}

// ── English number words (chapters & verses, 1–176) ────────────────────────

const ONES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Parse "23", "twenty-three", "one hundred nineteen" → int; null if not a number. */
export function parseEnglishNumber(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);

  const words = s.replace(/-/g, ' ').split(/\s+/).filter((w) => w !== 'and');
  let value = 0;
  let matched = false;
  for (const w of words) {
    if (w in ONES) { value += ONES[w]; matched = true; }
    else if (w in TEENS) { value += TEENS[w]; matched = true; }
    else if (w in TENS) { value += TENS[w]; matched = true; }
    else if (w === 'a') { if (value === 0) value = 1; } // "a hundred"
    else if (w === 'hundred') { value = (value || 1) * 100; matched = true; }
    else return null;
  }
  return matched ? value : null;
}

// A number token in running text: digits, or a short chain of number words
// ("twenty three", "one hundred and nineteen"). parseEnglishNumber validates
// whatever this matches, so a junk chain simply parses to null.
const NUM_WORD =
  '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|a|and)';
const NUM = `(?:\\d+|${NUM_WORD}(?:[-\\s]${NUM_WORD}){0,4})`;

// ── Book matching ──────────────────────────────────────────────────────────

// Spoken/STT variants that don't literally match the canonical names.
const ALIASES: Record<string, string[]> = {
  Psalms: ['psalm'],
  'Song of Songs': ['song of solomon'],
  Revelation: ['revelations'],
};

// Books whose English names are common given names: a bare mention is far
// more likely the PERSON ("John said to Jesus"). These only count as a book
// reference with positional evidence — a number/chapter right after, or
// "book of / gospel of / according to" right before. The numbered epistles
// ("1 John") are distinct variants and always unambiguous.
const AMBIGUOUS_NAME_BOOKS = new Set([
  'John', 'James', 'Mark', 'Luke', 'Jude', 'Job', 'Joel', 'Amos',
  'Ruth', 'Esther', 'Daniel', 'Titus', 'Philemon',
]);

// Ordinal-word variants for the numbered books ("First Corinthians").
const ORDINALS: Record<string, string[]> = { '1': ['first', '1st'], '2': ['second', '2nd'], '3': ['third', '3rd'] };

interface BookMatcher {
  book: string; // canonical English name (BOOK_MAP value)
  re: RegExp;
  ambiguous: boolean;
  variantLength: number;
}

const BOOK_MATCHERS: BookMatcher[] = [];
for (const en of Object.values(BOOK_MAP)) {
  const variants = [en.toLowerCase(), ...(ALIASES[en] ?? []).map((a) => a.toLowerCase())];
  const numbered = en.match(/^([123]) (.+)$/);
  if (numbered) {
    for (const ord of ORDINALS[numbered[1]]) variants.push(`${ord} ${numbered[2].toLowerCase()}`);
  }
  for (const v of variants) {
    BOOK_MATCHERS.push({
      book: en,
      re: new RegExp(`\\b${v.replace(/ /g, '\\s+')}\\b`),
      ambiguous: AMBIGUOUS_NAME_BOOKS.has(en),
      variantLength: v.length,
    });
  }
}
// Longest variant first, so "1 john" wins over "john", "song of songs" over "song".
BOOK_MATCHERS.sort((a, b) => b.variantLength - a.variantLength);

// ── Detection ──────────────────────────────────────────────────────────────

function toChapter(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseEnglishNumber(raw);
  return n && n > 0 && n < 200 ? n : null;
}

/**
 * Detect a Bible reference in an English segment. Returns whatever parts are
 * present (book / chapter / verse) as a ScriptureRef with the ENGLISH book
 * name (same shape as the Korean detector), or null if none found. Chapter
 * and verse often arrive in separate segments; callers merge across calls
 * with mergeReference.
 */
export function detectReferenceEn(text: string): ScriptureRef | null {
  const lower = text.toLowerCase();
  const ref: ScriptureRef = {};
  let afterBook = '';

  for (const m of BOOK_MATCHERS) {
    const hit = m.re.exec(lower);
    if (!hit) continue;
    const before = lower.slice(0, hit.index);
    const after = lower.slice(hit.index + hit[0].length);
    if (m.ambiguous) {
      const evidenceBefore = /(?:book|gospel)\s+of\s+$|according\s+to\s+$/.test(before);
      const evidenceAfter = new RegExp(`^[\\s,]*(?:chapter\\s|\\d)`).test(after);
      if (!evidenceBefore && !evidenceAfter) continue; // the person, not the book
    }
    ref.book = m.book;
    afterBook = after;
    break;
  }

  // Numbers directly after the book: "John 3", "John 3:16",
  // "John chapter 3[,] verse 16".
  if (ref.book && afterBook) {
    const m = afterBook.match(
      new RegExp(`^[\\s,]*(?:chapter\\s+)?(${NUM})(?:\\s*:\\s*(\\d+)|[\\s,]*verses?\\s+(${NUM}))?`, 'i'),
    );
    if (m) {
      const chap = toChapter(m[1]);
      if (chap) {
        ref.chapter = chap;
        const verse = toChapter(m[2] ?? m[3]);
        if (verse) ref.verse = verse;
      }
    }
  }

  // Keyword-marked chapter/verse anywhere — also covers bookless segments
  // ("now look at verse five"), mirroring the Korean lone-절 behavior.
  if (ref.chapter === undefined) {
    const m = lower.match(new RegExp(`\\bchapters?\\s+(${NUM})`));
    const chap = toChapter(m?.[1]);
    if (chap) ref.chapter = chap;
  }
  if (ref.verse === undefined) {
    const m = lower.match(new RegExp(`\\bverses?\\s+(${NUM})`));
    const verse = toChapter(m?.[1]);
    if (verse) ref.verse = verse;
  }

  return ref.book || ref.chapter || ref.verse ? ref : null;
}

/**
 * Format for Korean output/prompting: "요한복음 3장 16절", "고린도전서 13장",
 * "시편 23편" (Psalms conventionally uses 편, not 장). Null without a book.
 */
export function formatReferenceKorean(ref: ScriptureRef | null): string | null {
  if (!ref || !ref.book) return null;
  const kr = BOOK_EN_TO_KO[ref.book];
  if (!kr) return null;
  let s = kr;
  if (ref.chapter !== undefined) {
    s += ` ${ref.chapter}${kr === '시편' ? '편' : '장'}`;
    if (ref.verse !== undefined) s += ` ${ref.verse}절`;
  }
  return s;
}
