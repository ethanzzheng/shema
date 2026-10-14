/**
 * Which verse is the pastor reading? Mandarin pastors rarely say verse numbers
 * while they read — the first real service announced "约翰福音二十一章一到二十五节"
 * once and then read 25 verses with no further numbers, so the translator only
 * ever saw verse 1's canonical text and filled the rest from memory: it added
 * clauses the pastor skipped and ran ahead into verses he had not reached.
 *
 * The fix borrows the Korean pipeline's approach (a bundled public-domain
 * Bible) and goes one step further: match the spoken words against every verse
 * of the chapter in play, by shared character pairs. A reading matches its
 * verse strongly even through recognition errors (树上袋子 for 束上带子 still
 * shares most pairs), and commentary that merely mentions a word or two does
 * not.
 */
import { getChapterZh } from './bible';

/** Characters that vary between spoken/recognised text and the CUV print. */
const FOLD: Record<string, string> = { 祂: '他', 祢: '你', 妳: '你', 她: '他', 它: '他', 牠: '他', 哪: '那', 么: '么' };

function normalize(t: string): string {
  let out = '';
  for (const ch of t) {
    if (!/[一-鿿]/.test(ch)) continue; // keep Han characters only
    out += FOLD[ch] ?? ch;
  }
  return out;
}

function bigrams(t: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
  return out;
}

export interface VerseMatch {
  verse: number;
  /** Share of the verse's character pairs that were spoken (0-1). */
  coverage: number;
  text: string;
}

/**
 * Verses of `book chapter` that this segment reads from, in order. A verse
 * counts when enough of the SEGMENT is drawn from it — at least `minShare` of
 * the segment's character pairs and `minPairs` pairs in absolute terms — so a
 * long verse quoted in part still matches, and a passing mention does not.
 */
export function matchSpokenVersesZh(
  spoken: string,
  book: string,
  chapter: number,
  opts: { minPairs?: number; minShare?: number } = {},
): VerseMatch[] {
  const whole = matchVerses(spoken, book, chapter, opts);
  if (whole.length > 0) return whole;
  // A reading usually begins in the same breath as its announcement —
  // "…约翰福音二十一章一到二十五节…这些事以后耶稣在提比哩亚" — and the
  // announcement swamps the match. Try what follows the last 节/章/篇.
  const m = spoken.match(/[节章篇][^节章篇]*$/);
  const tail = m ? m[0].slice(1) : '';
  return tail && tail.length < spoken.length ? matchVerses(tail, book, chapter, opts) : [];
}

function matchVerses(
  spoken: string,
  book: string,
  chapter: number,
  opts: { minPairs?: number; minShare?: number } = {},
): VerseMatch[] {
  const minPairs = opts.minPairs ?? 5;
  const minShare = opts.minShare ?? 0.25;
  const verses = getChapterZh(book, chapter);
  const said = bigrams(normalize(spoken));
  if (verses.length === 0 || said.length < minPairs) return [];
  const saidSet = new Set(said);

  const scored = verses.map((v) => {
    const vb = new Set(bigrams(normalize(v.text)));
    const hits = new Set([...saidSet].filter((b) => vb.has(b)));
    let covered = 0;
    for (const b of vb) if (saidSet.has(b)) covered++;
    return { verse: v.verse, text: v.text, hits, coverage: vb.size ? covered / vb.size : 0 };
  });
  const best = scored.reduce((a, b) => (b.hits.size > a.hits.size ? b : a));
  if (best.hits.size < minPairs || best.hits.size / saidSet.size < minShare) return [];

  // Greedy cover: a neighbour joins only if it explains spoken words the
  // chosen verses do not. Scoring by strength alone cannot work — John 21:13
  // genuinely read alongside 21:14 scored 7 against 14's 18, while 21:15 and
  // 21:16, NOT read, scored 11 and 12 against 21:17's 15 because all three
  // share "约翰的儿子西门，你爱我吗". What separates them is that 13 adds words
  // and 15/16 add none.
  const chosen = [best];
  const explained = new Set(best.hits);
  for (;;) {
    let add: (typeof scored)[number] | null = null;
    let gain = 0;
    for (const s of scored) {
      if (chosen.includes(s)) continue;
      if (!chosen.some((c) => Math.abs(c.verse - s.verse) === 1)) continue; // contiguous only
      const g = [...s.hits].filter((b) => !explained.has(b)).length;
      if (g > gain) { gain = g; add = s; }
    }
    if (!add || gain < minPairs) break;
    chosen.push(add);
    for (const b of add.hits) explained.add(b);
  }
  return chosen
    .sort((a, b) => a.verse - b.verse)
    .map(({ verse, coverage, text }) => ({ verse, coverage, text }));
}

/**
 * A long reading outlives the broadcaster's reference timeout: John 21 was 29
 * segments read with one announced number, and the reference expired after 12
 * — halfway through. When the spoken words match a verse of the passage in
 * play, the passage is still being read: keep it, and move its verse along.
 * Returns true when the reference was refreshed.
 */
export function keepReadingZh(ref: { book?: string; chapter?: number; verse?: number } | null, spoken: string): boolean {
  if (!ref?.book || ref.chapter === undefined) return false;
  const m = matchSpokenVersesZh(spoken, ref.book, ref.chapter);
  if (m.length === 0) return false;
  ref.verse = m[0].verse;
  return true;
}
