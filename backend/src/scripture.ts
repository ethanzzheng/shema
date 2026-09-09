/**
 * Bible-reference detection for spoken Korean sermon text.
 *
 * The pastor announces references like "요한복음 십 삼 장 사 절" (John 13:4) or
 * "빌립보서 두 장" (Philippians 2). We detect the book + chapter + verse so the
 * translator can be ANCHORED to the exact passage and reproduce verbatim NIV,
 * instead of guessing scripture from garbled speech-to-text.
 *
 * Numbers may be Sino-Korean (일이삼…십), native Korean (하나/두/열세…), or Arabic.
 */

export interface ScriptureRef {
  book?: string; // English book name, e.g. "John"
  chapter?: number;
  verse?: number;
}

// Korean book names (개역 standard) → English. Longest names matched first.
// Exported so scripture-en.ts can invert it (English → Korean) without
// duplicating the data.
export const BOOK_MAP: Record<string, string> = {
  창세기: 'Genesis', 출애굽기: 'Exodus', 레위기: 'Leviticus', 민수기: 'Numbers', 신명기: 'Deuteronomy',
  여호수아: 'Joshua', 사사기: 'Judges', 룻기: 'Ruth', 사무엘상: '1 Samuel', 사무엘하: '2 Samuel',
  열왕기상: '1 Kings', 열왕기하: '2 Kings', 역대상: '1 Chronicles', 역대하: '2 Chronicles',
  에스라: 'Ezra', 느헤미야: 'Nehemiah', 에스더: 'Esther', 욥기: 'Job', 시편: 'Psalms',
  잠언: 'Proverbs', 전도서: 'Ecclesiastes', 아가: 'Song of Songs', 이사야: 'Isaiah',
  예레미야애가: 'Lamentations', 예레미야: 'Jeremiah', 에스겔: 'Ezekiel', 다니엘: 'Daniel',
  호세아: 'Hosea', 요엘: 'Joel', 아모스: 'Amos', 오바댜: 'Obadiah', 요나: 'Jonah', 미가: 'Micah',
  나훔: 'Nahum', 하박국: 'Habakkuk', 스바냐: 'Zephaniah', 학개: 'Haggai', 스가랴: 'Zechariah', 말라기: 'Malachi',
  마태복음: 'Matthew', 마가복음: 'Mark', 누가복음: 'Luke', 요한복음: 'John', 사도행전: 'Acts',
  로마서: 'Romans', 고린도전서: '1 Corinthians', 고린도후서: '2 Corinthians', 갈라디아서: 'Galatians',
  에베소서: 'Ephesians', 빌립보서: 'Philippians', 골로새서: 'Colossians',
  데살로니가전서: '1 Thessalonians', 데살로니가후서: '2 Thessalonians',
  디모데전서: '1 Timothy', 디모데후서: '2 Timothy', 디도서: 'Titus', 빌레몬서: 'Philemon',
  히브리서: 'Hebrews', 야고보서: 'James', 베드로전서: '1 Peter', 베드로후서: '2 Peter',
  요한일서: '1 John', 요한이서: '2 John', 요한삼서: '3 John', 유다서: 'Jude', 요한계시록: 'Revelation',
};

// Longest-first so "고린도전서" wins over any shorter substring, "예레미야애가" over "예레미야", etc.
const BOOK_NAMES = Object.keys(BOOK_MAP).sort((a, b) => b.length - a.length);

const SINO: Record<string, number> = {
  영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 륙: 6, 칠: 7, 팔: 8, 구: 9,
};
const NATIVE_TENS: [string, number][] = [
  ['아흔', 90], ['여든', 80], ['일흔', 70], ['예순', 60], ['쉰', 50], ['마흔', 40], ['서른', 30], ['스물', 20], ['스무', 20], ['열', 10],
];
const NATIVE_ONES: [string, number][] = [
  ['다섯', 5], ['여섯', 6], ['일곱', 7], ['여덟', 8], ['아홉', 9], ['하나', 1], ['한', 1], ['둘', 2], ['두', 2], ['셋', 3], ['세', 3], ['넷', 4], ['네', 4],
];

/** Parse a Korean/Arabic number string (chapters & verses, ~1–176) to an int. */
export function parseKoreanNumber(input: string): number | null {
  const s = input.replace(/\s/g, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);

  // Sino-Korean (has 십/백 or sino digits, no native words)
  if (/^[영공일이삼사오육륙칠팔구십백천]+$/.test(s)) {
    // Bare digit syllables with no place marker are not a number — they are
    // two separate words that happened to sit next to each other. "이 구"
    // ("this" + the 구 of 구절) previously summed to 9 and invented a verse.
    if (s.length > 1 && !/[십백천]/.test(s)) return null;
    let total = 0;
    let current = 0;
    for (const ch of s) {
      if (ch in SINO) current = SINO[ch];
      else if (ch === '십') { total += (current || 1) * 10; current = 0; }
      else if (ch === '백') { total += (current || 1) * 100; current = 0; }
      else if (ch === '천') { total += (current || 1) * 1000; current = 0; }
      else return null;
    }
    return total + current;
  }

  // Native Korean (열세, 스물여섯, 세 …)
  let rest = s;
  let total = 0;
  let matched = false;
  for (const [w, v] of NATIVE_TENS) {
    if (rest.startsWith(w)) { total += v; rest = rest.slice(w.length); matched = true; break; }
  }
  for (const [w, v] of NATIVE_ONES) {
    if (rest.startsWith(w)) { total += v; rest = rest.slice(w.length); matched = true; break; }
  }
  if (rest.length > 0 || !matched) return null;
  return total;
}

// Whole number-WORDS (not a char class) so book names ending in 서/etc. don't
// collide with the tens word 서른, and 복 with nothing, etc.
const NUM_TOKEN =
  '(?:영|공|일|이|삼|사|오|육|륙|칠|팔|구|십|백|천|하나|둘|셋|넷|다섯|여섯|일곱|여덟|아홉|열|스물|스무|서른|마흔|쉰|예순|일흔|여든|아흔|한|두|세|네|[0-9])';
/** A run of number tokens, e.g. "9", "사", "이 십 육", "열 세". */
const NUM_RUN = `${NUM_TOKEN}(?:\\s*${NUM_TOKEN})*`;
const CHAP_RE = new RegExp(`(제)?(${NUM_RUN})(\\s*)장`, 'g');
const VERSE_RE = new RegExp(`(제)?(${NUM_RUN})(\\s*)절`, 'g');

/**
 * What may legitimately follow 장/절 in a spoken reference: end of segment,
 * anything non-Hangul, or a particle/copula. 로 is deliberately absent — it is
 * what makes 장로님 ("elder") look like "chapter 1" when the preceding word
 * happens to end in 한.
 */
const REF_SUFFIX = /^(?:[^가-힣]|을|를|은|는|이|가|에|의|도|만|과|와|부|까|입|말|이?니|였|였|서)/;

/**
 * Find a chapter or verse number, rejecting the ordinary Korean words that
 * merely contain a number syllable.
 *
 * This matters more than it looks. 구절 is the everyday noun for "passage",
 * and its 구 is also the Sino numeral 9 — so "이 구절을 보시면" ("if you look
 * at this passage") used to parse as verse 9, silently rewriting a live
 * 2 Peter 1:3 anchor into 2 Peter 1:9 and feeding the translator the wrong
 * verse window. Likewise "귀한 장로님" ("precious elder") parsed as chapter 1.
 * Both were observed in the recorded service.
 *
 * The discriminator comes from how references are actually transcribed:
 * Deepgram renders a spoken reference with the number separated — "3 절",
 * "사 장", "일 장 3 절" — or as digits. The collisions are always glued into a
 * word. So a lone Sino syllable fused directly onto 장/절, with no 제 prefix
 * and no digit, is treated as an ordinary word.
 *
 * The trade is deliberately asymmetric: missing a reference costs a
 * chapter-level anchor, while inventing one puts a wrong verse number in the
 * pastor's mouth.
 */
function scanRefNumber(text: string, re: RegExp): number | null {
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const [full, jePrefix, run, gap] = m;
    const before = m.index > 0 ? text[m.index - 1] : '';
    // Must start at a boundary: a number fused to the end of a preceding word
    // is part of that word, not a reference.
    if (before && /[가-힣0-9]/.test(before)) continue;
    // Must not run on into a longer word (장로님, 절대…).
    const after = text.slice(m.index + full.length);
    if (after && !REF_SUFFIX.test(after)) continue;
    // A single Sino syllable glued to the marker is an ordinary noun.
    const glued = gap.length === 0 && !jePrefix;
    if (glued && run.length === 1 && !/[0-9]/.test(run)) continue;
    const n = parseKoreanNumber(run);
    if (n !== null && n > 0 && n < 200) return n;
  }
  return null;
}

/**
 * Detect a Bible reference in a Korean segment. Returns whatever parts are
 * present (book / chapter / verse), or null if none found. Chapter and verse
 * often arrive in separate segments, so callers should merge across calls.
 */
export function detectReference(text: string): ScriptureRef | null {
  const ref: ScriptureRef = {};

  for (const kr of BOOK_NAMES) {
    if (text.includes(kr)) { ref.book = BOOK_MAP[kr]; break; }
  }

  const chapter = scanRefNumber(text, CHAP_RE);
  if (chapter !== null) ref.chapter = chapter;
  const verse = scanRefNumber(text, VERSE_RE);
  if (verse !== null) ref.verse = verse;

  return ref.book || ref.chapter || ref.verse ? ref : null;
}

/**
 * Merge a freshly-detected reference into the running one. A new book resets
 * chapter/verse; a lone chapter or verse updates within the current book.
 */
export function mergeReference(current: ScriptureRef | null, next: ScriptureRef): ScriptureRef {
  if (next.book && next.book !== current?.book) {
    return { book: next.book, chapter: next.chapter, verse: next.verse };
  }
  const merged: ScriptureRef = { ...current };
  if (next.book) merged.book = next.book;
  if (next.chapter !== undefined) { merged.chapter = next.chapter; merged.verse = next.verse; }
  if (next.verse !== undefined) merged.verse = next.verse;
  return merged;
}

/** Format for the translator prompt, e.g. "John 13:4", "Philippians 2", "Isaiah". */
export function formatReference(ref: ScriptureRef | null): string | null {
  if (!ref || !ref.book) return null;
  let s = ref.book;
  if (ref.chapter !== undefined) {
    s += ` ${ref.chapter}`;
    if (ref.verse !== undefined) s += `:${ref.verse}`;
  }
  return s;
}
