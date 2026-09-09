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

/** Repetition *inside* one segment: the same substantive phrase twice. */
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
    if (best) out.push({ seq: s.seq, phrase: best.phrase, n: best.n, en: s.en, koHas: false });
  }
  return out;
}

// ── Verse references ──────────────────────────────────────────────────────
const KO_NUM: Record<string, number> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9, 십: 10 };

function koVerses(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d+)\s*절/g)) out.push(Number(m[1]));
  for (const m of text.matchAll(/([일이삼사오육칠팔구십]+)\s*절/g)) {
    const s = m[1];
    if (s.length === 1 && KO_NUM[s]) out.push(KO_NUM[s]);
    else if (s === '십') out.push(10);
  }
  return out;
}

function enVerses(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\bverses?\s+(\d+)/gi)) out.push(Number(m[1]));
  for (const m of text.matchAll(/\b\d+\s*:\s*(\d+)/g)) out.push(Number(m[1]));
  return out;
}

function verseAudit(segs: Seg[]): { seq: number; ko: number[]; en: number[]; koText: string; enText: string }[] {
  const rows: { seq: number; ko: number[]; en: number[]; koText: string; enText: string }[] = [];
  for (const s of segs) {
    const k = koVerses(s.ko);
    const e = enVerses(s.en);
    if (k.length === 0 && e.length === 0) continue;
    const mismatch = e.some((v) => !k.includes(v)) || k.some((v) => !e.includes(v));
    if (mismatch) rows.push({ seq: s.seq, ko: k, en: e, koText: s.ko, enText: s.en });
  }
  return rows;
}

// ── Dangling / ambiguous fragments ────────────────────────────────────────
const KO_DANGLING_TAIL = /(을|를|은|는|이|가|의|와|과|에|에게|에서|으로|로|도|만|까지|부터|처럼|같이)$/;

function danglingAudit(segs: Seg[]): { seq: number; ko: string; en: string; why: string[] }[] {
  const out: { seq: number; ko: string; en: string; why: string[] }[] = [];
  for (const s of segs) {
    const why: string[] = [];
    const koTail = s.ko.replace(/[\s.,!?…]+$/, '');
    if (KO_DANGLING_TAIL.test(koTail)) why.push('ko-ends-on-particle');
    const en = s.en.trim();
    if (/,$/.test(en)) why.push('en-ends-on-comma');
    // A whole segment that is just a noun phrase / appositive: opens with a
    // determiner or demonstrative and contains no finite verb.
    if (/^(that|the|those|these|this|a|an)\b/i.test(en) && !/\b(is|are|was|were|has|have|had|do|does|did|will|would|can|could|should|says?|said|tells?|gives?|makes?|comes?|goes)\b/i.test(en)) {
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
  console.log(`count ${internal.length}`);
  for (const r of internal.slice(0, 20)) console.log(`  seq ${r.seq} ×${r.n} "${r.phrase}"\n      ${r.en.slice(0, 110)}`);

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
    internalRepeats: internal.length,
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
