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
 * Words that (nearly) never end an English DECLARATIVE — behind a period
 * they betray a punctuated mid-clause cut ("...he took the loaves and.").
 * Conjunctions, relatives/complementizers, determiners ONLY. Auxiliaries
 * are deliberately NOT here: English ellipsis ends sentences on them
 * constantly in preaching ("Yes, he did.", "That's who you are.", "Give
 * him everything you have.") — vetoing those held every such line for the
 * full incomplete window and produced long live gaps.
 */
const HARD_CONNECTIVES = new Set([
  // conjunctions
  'and', 'but', 'or', 'nor', 'so', 'yet', 'because', 'although', 'though',
  'while', 'if', 'unless', 'until', 'since', 'when', 'whenever', 'where',
  'wherever', 'after', 'before', 'as', 'than',
  // relatives — NOT 'that': sentence-final demonstrative "Amen to that." /
  // "I believe that." is constant in preaching and must not be held.
  'which', 'who', 'whom', 'whose',
  // determiners / possessives
  'the', 'a', 'an', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'every', 'each',
]);

/**
 * Auxiliaries / copulas: unpunctuated they usually mean the predicate is
 * still coming ("and he will..."), so they extend the wait — but behind a
 * period they are legitimate elliptical endings and never veto.
 */
const AUXILIARIES = [
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'will', 'would',
  'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'have', 'has', 'had', 'do', 'does', 'did',
];

/**
 * Prepositions strand at real sentence ends constantly in preaching —
 * "What are you waiting for?", "That's what we live for.", "the church I
 * belong to." — so they signal incompleteness only while UNpunctuated;
 * they never veto a terminator.
 */
const STRANDABLE_PREPOSITIONS = new Set([
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'about',
  'through', 'over', 'under', 'between', 'among', 'toward', 'towards', 'upon',
  'without', 'within', 'unto',
]);

// The full "more is probably coming" set, for unpunctuated buffers. 'that',
// 'not', and the auxiliaries live only here: unpunctuated they usually
// continue ("the promise that...", "and he will..."), but behind a
// terminator they are legitimate endings.
const TRAILING_CONNECTIVES = new Set([
  ...HARD_CONNECTIVES,
  ...STRANDABLE_PREPOSITIONS,
  ...AUXILIARIES,
  'that',
  'not',
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

function trailingWordIn(text: string, set: Set<string>): boolean {
  const t = coreEnd(text).replace(/[,;:\s]+$/, '');
  const m = t.match(/([A-Za-z']+)$/);
  if (!m) return false;
  return set.has(m[1].toLowerCase());
}

/** Ends on a word that suggests an unfinished clause (unpunctuated buffers)? */
export function endsWithEnglishConnective(text: string): boolean {
  return trailingWordIn(text, TRAILING_CONNECTIVES);
}

/** Ends on a word that (nearly) never closes an English declarative? */
export function endsWithHardConnective(text: string): boolean {
  return trailingWordIn(text, HARD_CONNECTIVES);
}

/**
 * A high-confidence complete English sentence: real terminal punctuation,
 * and for a PERIOD, not a punctuated mid-clause cut (Deepgram writes
 * "...and the Lord said and." when the speaker pauses mid-sentence — the
 * trailing hard connective betrays it). Questions/exclamations are always
 * complete — "What are you waiting for?" ends on a stranded preposition,
 * and holding a punchy rhetorical line for the incomplete window is the
 * worst possible latency to add.
 */
export function looksCompleteEn(text: string): boolean {
  if (!endsWithStrongTerminatorEn(text)) return false;
  const t = coreEnd(text);
  if (t[t.length - 1] !== '.') return true;
  return !endsWithHardConnective(t.replace(/[.?!…]+$/, ''));
}

// A clause-relief head must be a real clause, not a stub.
const MIN_CLAUSE_HEAD = 40;

/**
 * Carve the longest comma/semicolon-bounded head off a run-on buffer.
 * English preaching is polysyndetic — clauses chain on "and... and..." with
 * commas and few periods, so a continuous speaker can go 30-40s without a
 * sentence boundary. Splitting at the LAST comma keeps the head maximal
 * (complete clauses) and the carried-over tail small. Returns null when
 * there is no comma far enough in ("3,000" never matches: comma+space only).
 */
export function splitLastClause(text: string): { head: string; rest: string } | null {
  const idx = Math.max(text.lastIndexOf(', '), text.lastIndexOf('; '));
  if (idx < MIN_CLAUSE_HEAD) return null;
  return { head: text.slice(0, idx + 1).trim(), rest: text.slice(idx + 1).trim() };
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
        (isAbbreviationPeriod(s.slice(start, i)) || endsWithHardConnective(s.slice(start, i)))
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
