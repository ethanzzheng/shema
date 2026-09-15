/**
 * Analysis over one pilot run (and optionally a diff against a baseline).
 *
 * Reads the artifacts written by pilot-run.ts and reports the five metrics the
 * live-pilot review asked for: repetition, verse-reference accuracy, ambiguous
 * fragments, per-clip loudness, and coverage. Stutter is measured in the
 * browser (backward seeks) and folded in via --stutter if supplied.
 *
 * The load-bearing idea: every English finding is classified against its
 * KOREAN source. A repeated phrase the pastor actually said is speaker
 * emphasis (a prompt concern); a repeat absent from the Korean is pipeline
 * duplication (a code bug). Eyeballing the English alone cannot tell them
 * apart, and guessing wrong sends you to fix the wrong layer.
 *
 * Usage:
 *   npx tsx evals/pilot-report.ts --label baseline [--against other] [--stutter N]
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { similarity } from './shared';

interface Seg {
  seq: number;
  t: number;
  en: string;
  ko: string;
}

const REPEAT_THRESHOLD = 0.8;

function arg(flag: string, dflt = ''): string {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
}

function loadRun(label: string): { dir: string; segs: Seg[]; summary: Record<string, unknown> } {
  const dir = path.join(__dirname, 'runs', label);
  const segs: Seg[] = [];
  const bySeq = new Map<number, Seg>();
  for (const line of fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    // The broadcaster copy carries the Korean; prefer it, fall back to the
    // listener copy so a run recorded before that change still reports.
    if (m.type !== 'translation') continue;
    const seq = m.seq as number;
    const prev = bySeq.get(seq);
    const seg: Seg = {
      seq,
      t: (m.t as number) ?? 0,
      en: ((m.sermon as string) || (m.direct as string) || prev?.en || '').trim(),
      ko: ((m.korean as string) || prev?.ko || '').trim(),
    };
    bySeq.set(seq, seg);
  }
  for (const s of [...bySeq.values()].sort((a, b) => a.seq - b.seq)) segs.push(s);
  const summaryPath = path.join(dir, 'summary.json');
  const summary = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : {};
  return { dir, segs, summary };
}

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** Longest common substring length, on normalized Korean (no tokenizer needed). */
function koOverlap(a: string, b: string): number {
  const x = a.replace(/\s+/g, '');
  const y = b.replace(/\s+/g, '');
  if (!x || !y) return 0;
  let best = 0;
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

// ── Repetition ────────────────────────────────────────────────────────────
interface Repeat {
  seqA: number;
  seqB: number;
  kind: 'exact' | 'prefix' | 'fuzzy';
  sim: number;
  cls: 'A-pipeline' | 'B-emphasis' | 'unknown';
  a: string;
  b: string;
  koShared: number;
}

function findRepeats(segs: Seg[]): Repeat[] {
  const out: Repeat[] = [];
  for (let i = 1; i < segs.length; i++) {
    const A = segs[i - 1];
    const B = segs[i];
    const na = norm(A.en);
    const nb = norm(B.en);
    if (!na || !nb) continue;
    let kind: Repeat['kind'] | null = null;
    if (na === nb) kind = 'exact';
    else if (na.length > 12 && (nb.startsWith(na) || na.startsWith(nb))) kind = 'prefix';
    else if (similarity(na, nb) > REPEAT_THRESHOLD) kind = 'fuzzy';
    if (!kind) continue;

    // Classify against the Korean. If the pastor's own words overlap
    // substantially, he repeated himself; if not, we duplicated him.
    const shared = koOverlap(A.ko, B.ko);
    const koLen = Math.min(A.ko.replace(/\s+/g, '').length, B.ko.replace(/\s+/g, '').length);
    let cls: Repeat['cls'] = 'unknown';
    if (A.ko && B.ko) cls = shared >= 6 && shared / Math.max(1, koLen) > 0.3 ? 'B-emphasis' : 'A-pipeline';
    out.push({
      seqA: A.seq,
      seqB: B.seq,
      kind,
      sim: +similarity(na, nb).toFixed(2),
      cls,
      a: A.en,
      b: B.en,
      koShared: shared,
    });
  }
  return out;
}

/**
 * Repetition *inside* one segment: the same substantive phrase twice.
 *
 * Classified against the Korean, exactly as adjacent repetition already is.
 * Preachers repeat themselves on purpose — "There is a fight for the truth,
 * and there is a fight for God", "when it's beyond our own strength, when
 * it's beyond our own will" — and counting that as pipeline duplication makes
 * the metric rise whenever the preaching is at its most rhetorical. Only a
 * phrase the English doubled and the KOREAN did not is a defect.
 */
function findInternalRepeats(segs: Seg[]): { seq: number; phrase: string; n: number; en: string; koHas: boolean }[] {
  const out: { seq: number; phrase: string; n: number; en: string; koHas: boolean }[] = [];
  for (const s of segs) {
    const words = norm(s.en).split(' ').filter(Boolean);
    if (words.length < 8) continue;
    const seen = new Map<string, number>();
    for (let n = 4; n <= Math.min(10, Math.floor(words.length / 2)); n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const g = words.slice(i, i + n).join(' ');
        seen.set(g, (seen.get(g) ?? 0) + 1);
      }
    }
    let best: { phrase: string; n: number } | null = null;
    for (const [g, c] of seen) {
      if (c < 2) continue;
      if (!best || g.length > best.phrase.length) best = { phrase: g, n: c };
    }
    if (!best) continue;
    // Did the pastor repeat himself? Korean has no spaces to tokenise on, so
    // look for any repeated run of characters long enough to be a phrase.
    const ko = s.ko.replace(/\s+/g, '');
    let koHas = false;
    for (let n = 6; n <= Math.min(20, Math.floor(ko.length / 2)) && !koHas; n++) {
      const seenKo = new Set<string>();
      for (let i = 0; i + n <= ko.length; i++) {
        const g = ko.slice(i, i + n);
        if (seenKo.has(g)) { koHas = true; break; }
        seenKo.add(g);
      }
    }
    out.push({ seq: s.seq, phrase: best.phrase, n: best.n, en: s.en, koHas });
  }
  return out;
}

// ── Verse references ──────────────────────────────────────────────────────
const KO_NUM: Record<string, number> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9, 십: 10 };

/** 십 = 10, 십육 = 16, 이십오 = 25. */
function sino(s: string): number {
  if (KO_NUM[s] !== undefined && s.length === 1) return KO_NUM[s];
  const i = s.indexOf('십');
  if (i === -1) return KO_NUM[s] ?? 0;
  const tens = i === 0 ? 1 : KO_NUM[s[i - 1]] ?? 0;
  const ones = i === s.length - 1 ? 0 : KO_NUM[s[i + 1]] ?? 0;
  return tens * 10 + ones;
}

const EN_ONES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50 };

/**
 * Numbers spoken during a Korean sermon frequently come back from the Korean
 * STT model as ENGLISH words — "Twenty five 전에는…" — or as bare digits. The
 * audit read only Korean numerals, so those segments looked like the English
 * had invented a verse number out of nothing. They are the same number.
 */
function loanNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\b(twenty|thirty|forty|fifty)[\s-]+(one|two|three|four|five|six|seven|eight|nine)\b/gi)) {
    out.push(EN_TENS[m[1].toLowerCase()] + EN_ONES[m[2].toLowerCase()]);
  }
  for (const m of text.matchAll(/\b(twenty|thirty|forty|fifty)\b/gi)) out.push(EN_TENS[m[1].toLowerCase()]);
  for (const m of text.matchAll(/\b([a-z]+)\b/gi)) {
    const v = EN_ONES[m[1].toLowerCase()];
    if (v) out.push(v);
  }
  // Chapter:verse spoken as a clock time ("02:25") and bare digits.
  for (const m of text.matchAll(/\b\d{1,3}\s*:\s*(\d{1,3})\b/g)) out.push(Number(m[1]));
  for (const m of text.matchAll(/\b(\d{1,3})\b/g)) out.push(Number(m[1]));
  return out;
}

function koVerses(text: string): number[] {
  const out: number[] = [];

  // Ranges: "21절부터 25절까지", and just as often "21절부터 25절입니다".
  // `까지?` only made the 지 optional — the 까 was still required — so the
  // spoken form without 까지 never matched here while the English side DID
  // expand its range. Every range reading therefore reported as a mismatch.
  for (const m of text.matchAll(/(\d+)\s*절\s*(?:부터|에서)\s*(?:(\d+)|([일이삼사오육칠팔구십]+))\s*절?\s*(?:까지)?/g)) {
    const end = m[2] ? Number(m[2]) : sino(m[3] ?? '');
    for (let v = Number(m[1]); end && v <= end; v++) out.push(v);
  }

  for (const m of text.matchAll(/(\d+)\s*절/g)) out.push(Number(m[1]));

  // Sino-numeral verses. One case is genuinely not a number: 구절, written
  // solid, is the ordinary word for "phrase" — "한 구절 한 구절" is "every
  // single phrase", and reading it as verse 9 twice was the single largest
  // source of false mismatches. Spaced 구 절 is a real citation and still
  // counts, as does every other numeral; requiring a nearby 장 instead was
  // tried and threw out legitimate readings like "사 절 초반부에".
  for (const m of text.matchAll(/([일이삼사오육칠팔구십]+)\s*절/g)) {
    const numeral = m[1];
    const solid = m[0].indexOf(' ') === -1 && m[0].indexOf('\u00a0') === -1;
    if (numeral === '구' && solid) continue;
    const v = sino(numeral);
    if (v) out.push(v);
  }

  return [...new Set(out)];
}

function enVerses(text: string): number[] {
  const out: number[] = [];
  // Ranges must expand, or "verses 3 through 4" reports only the 3 and every
  // reading of a range looks like a mismatch.
  for (const m of text.matchAll(/\bverses?\s+(\d+)\s*(?:-|–|to|through|and)\s*(\d+)/gi)) {
    for (let v = Number(m[1]); v <= Number(m[2]); v++) out.push(v);
  }
  for (const m of text.matchAll(/\bverses?\s+(\d+)/gi)) out.push(Number(m[1]));
  for (const m of text.matchAll(/\b\d+\s*:\s*(\d+)/g)) out.push(Number(m[1]));
  return out;
}

function verseAudit(segs: Seg[]): { seq: number; ko: number[]; en: number[]; koText: string; enText: string }[] {
  const rows: { seq: number; ko: number[]; en: number[]; koText: string; enText: string }[] = [];
  for (const s of segs) {
    // Two readings of the Korean, used in opposite directions.
    //   strict     — verse citations proper. A citation here that is MISSING
    //                from the English is a dropped reference.
    //   permissive — plus any number spoken loosely (English loan words, bare
    //                digits, clock-style "02:25"). These can only EXCUSE an
    //                English number, never demand one: the pastor says plenty
    //                of numbers that are not citations, and requiring each to
    //                reappear in the English was most of this metric's noise.
    const strict = koVerses(s.ko);
    const permissive = new Set([...strict, ...loanNumbers(s.ko)]);
    const e = enVerses(s.en);
    if (strict.length === 0 && e.length === 0) continue;
    // An English range reading ("verses 21 through 25") expands to every verse
    // between the endpoints, but the Korean only ever states the two ends. If
    // both ends are accounted for and the English run is contiguous, the
    // interior is the reading, not an invention.
    const sorted = [...new Set(e)].sort((a, b) => a - b);
    const contiguous =
      sorted.length > 1 && sorted.every((v, i) => i === 0 || v === sorted[i - 1] + 1);
    const spannedByRange =
      contiguous && permissive.has(sorted[0]) && permissive.has(sorted[sorted.length - 1]);
    const invented = !spannedByRange && e.some((v) => !permissive.has(v));
    const dropped = strict.some((v) => !e.includes(v));
    if (invented || dropped) {
      rows.push({ seq: s.seq, ko: strict, en: e, koText: s.ko, enText: s.en });
    }
  }
  return rows;
}

// ── Dangling / ambiguous fragments ────────────────────────────────────────
const KO_DANGLING_TAIL = /(을|를|은|는|이|가|의|와|과|에|에게|에서|으로|로|도|만|까지|부터|처럼|같이)$/;

/**
 * Sentence-final endings that merely LOOK like a stranded particle.
 *
 * Korean interrogatives close on 가 — 무엇인가, 어떻게 이럴 수가 있는가 — and 가
 * is also the subject particle, so the tail test read finished questions as
 * sentences cut off mid-phrase. "So what is the purpose of all these things?"
 * is not a fragment. Likewise 는데/ㄴ데 and the 요/죠 endings.
 */
const KO_SENTENCE_FINAL = /(는가|은가|인가|ㄴ가|던가|나요|가요|까요|는데요|은데요|군요|네요|지요|죠|습니까|ㅂ니까|입니까)$/;

function danglingAudit(segs: Seg[]): { seq: number; ko: string; en: string; why: string[] }[] {
  const out: { seq: number; ko: string; en: string; why: string[] }[] = [];
  for (const s of segs) {
    const why: string[] = [];
    const koTail = s.ko.replace(/[\s.,!?…]+$/, '');
    if (KO_DANGLING_TAIL.test(koTail) && !KO_SENTENCE_FINAL.test(koTail)) {
      why.push('ko-ends-on-particle');
    }
    const en = s.en.trim();
    if (/,$/.test(en)) why.push('en-ends-on-comma');
    // A whole segment that is just a noun phrase / appositive — the shape the
    // English takes when the Korean was cut before its verb.
    //
    // This has now produced false positives twice, and each time they cost a
    // round of review chasing a defect that was not there. The allow-list of
    // verbs can never be complete: it was missing every irregular past
    // ("forgot", "knew", "spoke") and every bare imperative ("Listen", "Add",
    // "Go") a preacher actually uses, so "They forgot the grace of the cross."
    // and "Now go in peace." were both reported as fragments.
    //
    // Two structural guards do more than lengthening the list ever will:
    //   · a pronoun subject means it is a sentence, whatever the verb is;
    //   · a real noun phrase has to START like one.
    // Under-flagging is the right failure here — a missed fragment costs one
    // awkward line, a false one costs a review cycle.
    const VERBISH =
      /\b(?:is|are|was|were|am|be|being|been|has|have|had|do|does|did|will|would|can|could|shall|should|must|may|might|let|lets|[a-z]+ed|[a-z]+ing|says?|said|tells?|told|gives?|gave|makes?|made|comes?|came|go|goes|went|brings?|brought|meets?|met|needs?|wants?|knows?|knew|sees?|saw|thinks?|thought|loves?|lives?|prays?|reads?|hopes?|feels?|felt|forgets?|forgot|senses?|recalls?|remembers?|listens?|listen|adds?|add|takes?|took|hears?|heard|finds?|found|keeps?|kept|holds?|held|stands?|stood|sings?|sang|asks?|speaks?|spoke|writes?|wrote|becomes?|became|begins?|began|leaves?|left|loses?|lost|means?|meant|sends?|sent|spends?|spent|teaches?|taught|wins?|won|understands?|understood)\b/i;
    const CONTRACTION = /(?:'m|'re|'s|'ve|'ll|'d|n't)\b/i;
    // "They forgot." / "I still sense…" — a subject pronoun makes it a clause.
    const PRONOUN_SUBJECT = /^(?:i|you|he|she|it|we|they|there|here)\b/i;
    // A bare noun phrase opens like one: determiner, demonstrative, possessive,
    // or a preposition heading a stranded adjunct ("Among church members.").
    const NOUN_PHRASE_OPENER =
      /^(?:the|a|an|this|that|these|those|my|our|your|his|her|its|their|among|about|for|with|in|on|at|to|from|of|by)\b/i;
    if (
      !VERBISH.test(en) &&
      !CONTRACTION.test(en) &&
      !PRONOUN_SUBJECT.test(en) &&
      NOUN_PHRASE_OPENER.test(en)
    ) {
      why.push('en-bare-noun-phrase');
    }
    if (why.length) out.push({ seq: s.seq, ko: s.ko, en, why });
  }
  return out;
}

// ── Loudness ──────────────────────────────────────────────────────────────
function clipLoudness(dir: string): { seq: number; mean: number; max: number; dur: number }[] {
  const clipDir = path.join(dir, 'clips');
  if (!fs.existsSync(clipDir)) return [];
  const rows: { seq: number; mean: number; max: number; dur: number }[] = [];
  for (const f of fs.readdirSync(clipDir).filter((x) => x.endsWith('.mp3')).sort()) {
    const p = path.join(clipDir, f);
    let out = '';
    try {
      // volumedetect writes to stderr at info level, so -v error would hide it.
      execFileSync('ffmpeg', ['-hide_banner', '-i', p, '-af', 'volumedetect', '-f', 'null', '-'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      out = String((e as { stderr?: Buffer }).stderr ?? '');
    }
    if (!out) {
      try {
        const r = execFileSync(
          'bash',
          ['-c', `ffmpeg -hide_banner -i ${JSON.stringify(p)} -af volumedetect -f null - 2>&1`],
          { encoding: 'utf8' },
        );
        out = r;
      } catch {
        continue;
      }
    }
    const mean = Number(out.match(/mean_volume:\s*(-?[\d.]+)/)?.[1] ?? NaN);
    const max = Number(out.match(/max_volume:\s*(-?[\d.]+)/)?.[1] ?? NaN);
    const dur = Number(out.match(/Duration:\s*(\d+):(\d+):([\d.]+)/)?.slice(1).reduce((a, v, i) => a + Number(v) * [3600, 60, 1][i], 0) ?? NaN);
    if (!Number.isNaN(mean)) rows.push({ seq: Number(f.match(/(\d+)/)?.[1] ?? 0), mean, max, dur });
  }
  return rows;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ── Main ──────────────────────────────────────────────────────────────────
function report(label: string, stutter: string): Record<string, unknown> {
  const { dir, segs, summary } = loadRun(label);
  const repeats = findRepeats(segs);
  const internal = findInternalRepeats(segs);
  const verses = verseAudit(segs);
  const dangling = danglingAudit(segs);
  const loud = clipLoudness(dir);
  const means = loud.map((l) => l.mean);
  const med = median(means);
  const quiet = loud.filter((l) => l.mean < med - 6).sort((a, b) => a.mean - b.mean);

  console.log(`\n${'='.repeat(72)}\nPILOT REPORT — ${label}\n${'='.repeat(72)}`);
  console.log(`segments: ${segs.length}  ·  clips: ${loud.length}  ·  audio: ${summary.audioSeconds ?? '?'}s`);
  if (stutter) console.log(`stutter (backward seeks into played audio): ${stutter}`);

  console.log(`\n── REPETITION (adjacent, sim > ${REPEAT_THRESHOLD}) ─────────────────────────`);
  const clsA = repeats.filter((r) => r.cls === 'A-pipeline');
  const clsB = repeats.filter((r) => r.cls === 'B-emphasis');
  console.log(`total ${repeats.length}  ·  Class A (pipeline dup) ${clsA.length}  ·  Class B (speaker emphasis) ${clsB.length}  ·  unknown ${repeats.length - clsA.length - clsB.length}`);
  for (const r of repeats) {
    console.log(`  [${r.cls}] ${r.seqA}→${r.seqB} ${r.kind} sim=${r.sim} koShared=${r.koShared}`);
    console.log(`      A: ${r.a.slice(0, 100)}`);
    console.log(`      B: ${r.b.slice(0, 100)}`);
  }
  console.log(`\n── REPETITION (within one segment) ──────────────────────────────`);
  // Only the English-only doublings are defects; the rest is the preaching.
  const internalDup = internal.filter((r) => !r.koHas);
  const internalEmphasis = internal.length - internalDup.length;
  console.log(
    `count ${internalDup.length} pipeline` +
      (internalEmphasis ? `  ·  ${internalEmphasis} speaker emphasis (Korean repeats it too)` : ''),
  );
  for (const r of internalDup.slice(0, 20)) console.log(`  seq ${r.seq} ×${r.n} "${r.phrase}"\n      ${r.en.slice(0, 110)}`);

  console.log(`\n── VERSE REFERENCES (ko source vs en output) ────────────────────`);
  console.log(`mismatches: ${verses.length}`);
  for (const v of verses) {
    console.log(`  seq ${v.seq}: ko=[${v.ko}] en=[${v.en}]`);
    console.log(`      KO: ${v.koText.slice(0, 90)}`);
    console.log(`      EN: ${v.enText.slice(0, 90)}`);
  }

  console.log(`\n── AMBIGUOUS / DANGLING FRAGMENTS ───────────────────────────────`);
  console.log(`count ${dangling.length}`);
  for (const d of dangling.slice(0, 30)) {
    console.log(`  seq ${d.seq} [${d.why.join(',')}]`);
    console.log(`      KO: ${d.ko.slice(0, 85)}`);
    console.log(`      EN: ${d.en.slice(0, 85)}`);
  }

  console.log(`\n── CLIP LOUDNESS ────────────────────────────────────────────────`);
  if (loud.length) {
    console.log(`median mean_volume ${med.toFixed(1)} dB  ·  range ${Math.min(...means).toFixed(1)} … ${Math.max(...means).toFixed(1)} dB`);
    console.log(`clips >6 dB below median: ${quiet.length}`);
    for (const q of quiet.slice(0, 15)) {
      const seg = segs.find((s) => s.seq === q.seq);
      console.log(`  seq ${q.seq} ${q.mean.toFixed(1)} dB (dur ${q.dur.toFixed(1)}s) — ${(seg?.en ?? '').slice(0, 70)}`);
    }
  } else {
    console.log('no clips found');
  }

  return {
    label,
    segments: segs.length,
    repeats: repeats.length,
    classA: clsA.length,
    classB: clsB.length,
    internalRepeats: internal.filter((r) => !r.koHas).length,
    verseMismatches: verses.length,
    dangling: dangling.length,
    clips: loud.length,
    loudnessMedian: +med.toFixed(1),
    quietClips: quiet.length,
    stutter: stutter || 'not measured',
  };
}

const label = arg('--label', 'baseline');
const against = arg('--against');
const mine = report(label, arg('--stutter'));
fs.writeFileSync(path.join(__dirname, 'runs', label, 'report.json'), JSON.stringify(mine, null, 2));

if (against) {
  const theirs = report(against, '');
  console.log(`\n${'='.repeat(72)}\nDIFF: ${against} → ${label}\n${'='.repeat(72)}`);
  const keys = ['segments', 'repeats', 'classA', 'classB', 'internalRepeats', 'verseMismatches', 'dangling', 'quietClips'];
  for (const k of keys) {
    const a = theirs[k] as number;
    const b = mine[k] as number;
    const d = b - a;
    console.log(`  ${k.padEnd(18)} ${String(a).padStart(5)} → ${String(b).padStart(5)}   ${d > 0 ? '+' : ''}${d}`);
  }
}
