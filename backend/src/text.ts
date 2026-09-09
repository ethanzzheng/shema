/**
 * Sentence-boundary helpers for mixed Korean/English sermon text.
 *
 * Used by the STT layer and the chunker to hold text until a genuine
 * sentence end, so translations and TTS clips are sentence-sized
 * (coherent) instead of fragmented mid-thought (choppy).
 */

// Punctuation that ends a sentence (Latin + full-width CJK forms).
const PUNCT = '.!?。！？…';

// Closing quotes/brackets that may trail a terminator: `그랬다."` still counts.
const CLOSERS = `"'”’)]】」』`;

// Korean sentence-ending syllables/endings, longest first so we match the
// most specific. Declarative/polite/interrogative enders — 다 요 까 죠 네 and
// common polite/formal variants. Only ever checked at the END of a buffer
// (never used to split mid-text), so the risk of a false boundary is low.
const KOREAN_ENDERS = [
  '습니다', '읍니다', '십시오', '세요', '어요', '아요', '지요', '네요', '군요',
  '다', '요', '까', '죠', '네',
];

/**
 * Korean sentence-FINAL endings (formal/polite register, as in preaching).
 * High precision: "습니다/입니다…" (→ 니다), "…시오", "…죠", and any "…요" form.
 * A buffer ending here is grammatically COMPLETE.
 */
const KO_FINAL_ENDINGS = ['니다', '시오', '죠', '요'];

/**
 * Korean CONNECTIVE / particle endings — the clause is grammatically INCOMPLETE
 * and more is coming ("-고" and, "-면" if, "-서" so, "-은/는/을/를" particles…).
 * When a buffer ends like this, a mid-sentence pause is NOT a sentence end.
 */
const KO_CONNECTIVE_ENDINGS = [
  '고', '며', '면', '서', '는데', '은데', '지만', '다가', '거나', '든지', '려고', '도록',
  '으며', '으면', '아서', '어서', '여서', '게',
  '은', '는', '이', '가', '을', '를', '에게', '에서', '에', '의', '와', '과', '으로', '로',
  '도', '만', '까지', '부터', '보다', '처럼', '같이', '이나', '랑',
];

/** Strip trailing whitespace + closing quotes/brackets, return the core text. */
function coreEnd(text: string): string {
  let t = text.trimEnd();
  let end = t.length;
  while (end > 0 && CLOSERS.includes(t[end - 1])) end--;
  return t.slice(0, end);
}

/**
 * Does this text end on STRONG sentence-final punctuation (. ? ! …)?
 * Excludes Korean enders — used when we want a high-confidence sentence end.
 */
export function endsWithStrongTerminator(text: string): boolean {
  const t = coreEnd(text);
  if (!t) return false;
  return PUNCT.includes(t[t.length - 1]);
}

/** Ends on a Korean sentence-final ending (grammatically complete)? */
export function endsWithKoreanFinalEnding(text: string): boolean {
  const t = coreEnd(text);
  if (!t) return false;
  return KO_FINAL_ENDINGS.some((e) => t.endsWith(e));
}

/** Ends on a Korean connective/particle (grammatically incomplete — more coming)? */
export function endsWithKoreanConnective(text: string): boolean {
  const t = coreEnd(text);
  if (!t) return false;
  if (KO_FINAL_ENDINGS.some((e) => t.endsWith(e))) return false; // a final ending wins
  return KO_CONNECTIVE_ENDINGS.some((e) => t.endsWith(e));
}

/**
 * Nominal particles and adnominal endings that leave a SYNTACTIC HOLE — the
 * head noun or the verb they attach to has not arrived yet.
 *
 * This is a stricter, more dangerous subset of the connectives above. A verbal
 * connective ("-고" and, "-서" so) still renders as a standalone English
 * clause, so shipping it early merely sounds clipped. A dangling object
 * particle does not: Korean puts the object and its modifiers BEFORE the head
 * noun, so cutting there strands a modifier that English then attaches to
 * whatever preceded it.
 *
 * That is how the live service produced
 *   "The church of Jesus Christ, the church that he bought with his own blood,"
 *   "That terrible self-centeredness that tries to make it their own,"
 * from one sentence — read together it appears to call Christ's sacrifice
 * self-centered. Worth extra patience to avoid.
 */
const KO_DANGLING_PARTICLES = [
  '은', '는', '이', '가', '을', '를', '의', '와', '과', '랑',
  '에게', '에서', '에', '으로', '로', '도', '만', '까지', '부터', '보다', '처럼', '같이', '이나',
];

/** Adnominal verb endings: "-는/-은/-ㄴ/-던 <noun>" with the noun still missing. */
const KO_ADNOMINAL = ['하는', '되는', '있는', '없는', '리는', '지는', '시는', '느는', '했던', '하던', '이던'];

/**
 * Ends on something that needs a head noun or verb to follow?
 *
 * Deliberately narrower than endsWithKoreanConnective: this marks the cuts
 * that can INVERT meaning, not merely the ones that sound abrupt.
 */
export function endsWithDanglingHead(text: string): boolean {
  const t = coreEnd(text);
  if (!t) return false;
  if (KO_FINAL_ENDINGS.some((e) => t.endsWith(e))) return false; // complete wins
  if (KO_ADNOMINAL.some((e) => t.endsWith(e))) return true;
  return KO_DANGLING_PARTICLES.some((e) => t.endsWith(e));
}

/**
 * Split off the longest leading portion that ends at a SAFE boundary, leaving
 * the dangling tail buffered for its head.
 *
 * Used when patience runs out on an incomplete buffer: shipping the safe head
 * and holding the fragment beats shipping a modifier with nothing to modify.
 * Returns null when there is no safe cut, in which case the caller must decide
 * whether to ship the whole thing.
 */
export function splitLastKoreanClause(text: string, minHead = 12): { head: string; rest: string } | null {
  const t = text.trim();
  if (t.length < minHead * 2) return null;
  // Prefer a sentence end, then a comma; scan backwards for the last one that
  // still leaves a substantial head and a non-empty tail.
  for (const marks of [['.', '?', '!', '다', '요', '죠'], [',', '·']]) {
    for (let i = t.length - minHead; i >= minHead; i--) {
      if (!marks.includes(t[i])) continue;
      const head = t.slice(0, i + 1).trim();
      const rest = t.slice(i + 1).trim();
      if (head.length >= minHead && rest.length > 0 && !endsWithDanglingHead(head)) {
        return { head, rest };
      }
    }
  }
  return null;
}

/** A high-confidence complete sentence: strong punctuation or a Korean final ending. */
export function looksComplete(text: string): boolean {
  return endsWithStrongTerminator(text) || endsWithKoreanFinalEnding(text);
}

/**
 * Does this text end at a natural sentence boundary?
 * True for terminal punctuation, or a Korean sentence-ending syllable.
 */
export function endsWithTerminator(text: string): boolean {
  let t = text.trimEnd();
  if (!t) return false;

  // Strip trailing closing quotes/brackets before inspecting the last char.
  let end = t.length;
  while (end > 0 && CLOSERS.includes(t[end - 1])) end--;
  t = t.slice(0, end);
  if (!t) return false;

  if (PUNCT.includes(t[t.length - 1])) return true;
  for (const ender of KOREAN_ENDERS) {
    if (t.endsWith(ender)) return true;
  }
  return false;
}

/**
 * Split text into complete sentences plus a trailing remainder.
 *
 * Splits on terminal punctuation that is followed by whitespace or end-of-text
 * (so decimals like "3.16" and refs like "John 3:16" stay intact). Korean
 * enders are NOT used to split here — only whole-buffer boundaries are decided
 * by endsWithTerminator — to avoid cutting a sentence mid-word.
 */
export function splitSentences(text: string): { sentences: string[]; remainder: string } {
  const s = text;
  const n = s.length;
  const sentences: string[] = [];
  let start = 0;
  let i = 0;

  while (i < n) {
    if (PUNCT.includes(s[i])) {
      let end = i + 1;
      while (end < n && CLOSERS.includes(s[end])) end++;
      if (end >= n || /\s/.test(s[end])) {
        const seg = s.slice(start, end).trim();
        if (seg) sentences.push(seg);
        while (end < n && /\s/.test(s[end])) end++;
        start = end;
        i = end;
        continue;
      }
    }
    i++;
  }

  return { sentences, remainder: s.slice(start).trim() };
}
