/**
 * Sentence-boundary helpers for ENGLISH sermon text (en-ko direction).
 *
 * Mirrors text.ts (the Korean helpers) without touching it. English has no
 * sentence-final morphology, so completeness rides on punctuation — but two
 * STT realities need handling:
 *
 *   1. Abbreviations ("Dr.", "St.", "vs.", initials) end in a period that is
 *      NOT a sentence boundary.
 *   2. Deepgram punctuates at pause boundaries, so a mid-clause cut can
 *      arrive as "...and the Lord said and." — a trailing conjunction /
 *      preposition / determiner vetoes completeness even behind a period.
 */

// Punctuation that ends a sentence, and closers that may trail it — same
// sets as text.ts (kept private there; Korean logic stays untouched).
const PUNCT = '.!?…';
const CLOSERS = `"'”’)]`;

/**
 * Trailing tokens whose period is an abbreviation, not a boundary. STT of
 * spoken sermons mostly spells words out, so this stays modest: titles,
 * common Latin abbreviations, and verse/chapter shorthands.
 */
const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'st', 'vs', 'etc', 'rev', 'jr', 'sr', 'prof', 'hon',
  'e.g', 'i.e', 'a.m', 'p.m', 'v', 'vv', 'ch', 'chap',
]);

/**
 * Words that cannot END an English sentence — a buffer ending here is
 * mid-clause and more is coming ("...and", "...because", "...which",
 * "...of", "...the"). Conjunctions, relatives/complementizers, common
 * prepositions, determiners, and auxiliaries.
 */
const TRAILING_CONNECTIVES = new Set([
  // conjunctions ("so that" is covered by its trailing "that")
  'and', 'but', 'or', 'nor', 'so', 'yet', 'because', 'although', 'though',
  'while', 'if', 'unless', 'until', 'since', 'when', 'whenever', 'where',
  'wherever', 'after', 'before', 'as', 'than',
  // relatives / complementizers
  'that', 'which', 'who', 'whom', 'whose',
  // prepositions commonly stranded mid-clause
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'about',
  'through', 'over', 'under', 'between', 'among', 'toward', 'towards', 'upon',
  'without', 'within', 'unto',
  // determiners / possessives
  'the', 'a', 'an', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'every', 'each',
  // auxiliaries / copulas that leave the predicate hanging
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'will', 'would',
  'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'have', 'has', 'had', 'do', 'does', 'did', 'not',
]);

/** Strip trailing whitespace + closing quotes/brackets, return the core text. */
function coreEnd(text: string): string {
  const t = text.trimEnd();
  let end = t.length;
  while (end > 0 && CLOSERS.includes(t[end - 1])) end--;
  return t.slice(0, end);
}

/** The trailing word-with-optional-interior-dots before position `end`. */
function trailingToken(text: string): string | null {
  const m = text.match(/([A-Za-z]+(?:\.[A-Za-z]+)*)$/);
  return m ? m[1] : null;
}

/** True when a trailing period belongs to an abbreviation or an initial. */
function isAbbreviationPeriod(beforePeriod: string): boolean {
  const token = trailingToken(beforePeriod);
  if (!token) return false;
  if (token.length === 1) return true; // an initial: "John F."
  return ABBREVIATIONS.has(token.toLowerCase());
}

/**
 * Ends on strong sentence-final punctuation (. ? ! …) that is a REAL
 * boundary — an abbreviation's period ("Dr.", "e.g.") does not count.
 */
export function endsWithStrongTerminatorEn(text: string): boolean {
  const t = coreEnd(text);
  if (!t) return false;
  const last = t[t.length - 1];
  if (!PUNCT.includes(last)) return false;
  if (last !== '.') return true;
  return !isAbbreviationPeriod(t.slice(0, -1));
}

/** Ends on a word that cannot close an English clause (more is coming)? */
export function endsWithEnglishConnective(text: string): boolean {
  const t = coreEnd(text).replace(/[,;:\s]+$/, '');
  const m = t.match(/([A-Za-z']+)$/);
  if (!m) return false;
  return TRAILING_CONNECTIVES.has(m[1].toLowerCase());
}

/**
 * A high-confidence complete English sentence: real terminal punctuation AND
 * not a punctuated mid-clause cut (Deepgram writes "...and the Lord said
 * and." when the speaker pauses mid-sentence — the trailing connective
 * betrays it).
 */
export function looksCompleteEn(text: string): boolean {
  if (!endsWithStrongTerminatorEn(text)) return false;
  const beforePunct = coreEnd(text).replace(/[.?!…]+$/, '');
  return !endsWithEnglishConnective(beforePunct);
}

/**
 * Split text into complete sentences plus a trailing remainder — the same
 * walk as text.ts's splitSentences (terminal punctuation followed by
 * whitespace/end keeps "3.16" and "John 3:16" intact), plus two vetoes: a
 * period after an abbreviation/initial never splits, and a period after a
 * trailing connective ("...he prayed and. Then") is a punctuated mid-clause
 * pause — the clause rides on rather than shipping as a cut.
 */
export function splitSentencesEn(text: string): { sentences: string[]; remainder: string } {
  const s = text;
  const n = s.length;
  const sentences: string[] = [];
  let start = 0;
  let i = 0;

  while (i < n) {
    if (PUNCT.includes(s[i])) {
      if (
        s[i] === '.' &&
        (isAbbreviationPeriod(s.slice(start, i)) || endsWithEnglishConnective(s.slice(start, i)))
      ) {
        i++;
        continue;
      }
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
