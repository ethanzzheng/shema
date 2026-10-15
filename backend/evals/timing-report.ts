/**
 * Timing report for one pilot run: how long after the pastor finishes a
 * sentence does a listener hear it, and does the audio fall behind?
 *
 * Reads what pilot-run.ts wrote (messages.jsonl, clips/, summary.json) and,
 * for every translated chunk, lines up:
 *
 *   speech end     where the chunk's last STT final ends in the source audio
 *                  (Deepgram's audioEndSec + the run's audioStartT)
 *   STT final      when that final reached the desk
 *   translated     when the translation was broadcast
 *   first byte     when its first TTS audio reached the listener
 *   play start/end a simulated listener: clips play back to back at 1.0x, each
 *                  as soon as its first byte has arrived and the one before
 *                  has finished
 *
 * Backlog is translated speech that has arrived but not yet been heard. The
 * real phone player speeds up to 1.15x past 15s of backlog; this simulation
 * does not, so its backlog is the honest "how far behind the pipeline is".
 *
 * Writes timing.json and side-by-side.md (source | translation, for a native
 * speaker to review) into the run's folder.
 *
 *   npx tsx evals/timing-report.ts --label <run> [--against <baseline-run>]
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { findRunDir } from './recordings';

function arg(flag: string, dflt = ''): string {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
}

interface Msg { t: number; type: string; src?: string; [k: string]: unknown }

interface ChunkTiming {
  seq: number;
  source: string;
  translation: string;
  speechEnd: number | null;
  sttFinal: number | null;
  translated: number;
  firstByte: number | null;
  clipSec: number | null;
  playStart: number | null;
  playEnd: number | null;
  /** speech end → play start: what the listener experiences. */
  lag: number | null;
  /** Translated audio waiting to be heard when this chunk arrived. */
  backlogAtArrival: number | null;
}

/** Characters that carry meaning; spacing and punctuation differ between a final and its chunk. */
const norm = (s: string): string => s.replace(/[\s\p{P}\p{S}]+/gu, '');

function pct(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function clipDuration(file: string): number | null {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    const d = parseFloat(out.toString());
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

function analyse(label: string) {
  const dir = findRunDir(label);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  const msgs: Msg[] = fs
    .readFileSync(path.join(dir, 'messages.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const audioStartT: number | undefined = summary.audioStartT;
  const finals = msgs.filter((m) => m.src === 'broadcaster' && m.type === 'transcript' && m.isFinal);
  const translations = msgs.filter((m) => m.src === 'broadcaster' && m.type === 'translation');
  const firstByte = new Map<number, number>();
  for (const m of msgs) {
    if (m.src !== 'broadcaster' && m.type === 'audio_chunk' && !firstByte.has(m.seq as number)) {
      firstByte.set(m.seq as number, m.t);
    }
  }

  // Lay every final end to end as one normalized string, remembering which
  // final each character came from. A chunk is then located by searching for
  // its ending just past where the previous chunk ended. This survives what
  // breaks a final-by-final walk: the chunker splitting one final across two
  // chunks at a sentence boundary, and dropping a final it judged a repeat.
  const stream: string[] = [];
  const owner: number[] = [];
  const offsetInFinal: number[] = [];
  finals.forEach((f, i) => {
    const chars = [...norm(String(f.korean ?? ''))];
    chars.forEach((ch, k) => {
      stream.push(ch);
      owner.push(i);
      offsetInFinal.push(k + 1);
    });
  });
  const text = stream.join('');
  const finalLen = finals.map((f) => [...norm(String(f.korean ?? ''))].length);

  /** When the speech up to this character ended: interpolated inside its final. */
  const speechEndAt = (pos: number): number | null => {
    const f = finals[owner[pos]];
    const end = typeof f.audioEndSec === 'number' ? (f.audioEndSec as number) : null;
    if (end === null) return null;
    const start = typeof f.audioStartSec === 'number' ? (f.audioStartSec as number) : null;
    if (start === null) return end; // runs recorded before audioStartSec existed
    return start + (end - start) * (offsetInFinal[pos] / finalLen[owner[pos]]);
  };

  let cursor = 0;
  let clockResets = 0;
  let lastEnd = -1;
  const chunks: ChunkTiming[] = [];
  for (const tr of translations) {
    const source = String(tr.korean ?? '');
    const n = [...norm(source)];
    let endPos = -1;
    // Longest tail first, shortening until it is found close ahead.
    for (let len = Math.min(12, n.length); len >= 3 && endPos < 0; len--) {
      const tail = n.slice(-len).join('');
      const window = text.slice(cursor, cursor + n.length * 3 + 200);
      const at = window.indexOf(tail);
      if (at >= 0) endPos = cursor + at + tail.length - 1;
    }
    let endSec: number | null = null;
    let last: Msg | null = null;
    if (endPos >= 0) {
      cursor = endPos + 1;
      last = finals[owner[endPos]];
      endSec = speechEndAt(endPos);
    }
    if (endSec !== null) {
      if (endSec + 1 < lastEnd) clockResets++;
      lastEnd = endSec;
    }
    const seq = Number(tr.seq);
    const clip = path.join(dir, 'clips', `seq-${String(seq).padStart(4, '0')}.mp3`);
    chunks.push({
      seq,
      source,
      translation: String(tr.sermon ?? ''),
      speechEnd: endSec !== null && audioStartT !== undefined ? +(audioStartT + endSec).toFixed(2) : null,
      sttFinal: last ? last.t : null,
      translated: tr.t,
      firstByte: firstByte.get(seq) ?? null,
      clipSec: fs.existsSync(clip) ? clipDuration(clip) : null,
      playStart: null,
      playEnd: null,
      lag: null,
      backlogAtArrival: null,
    });
  }

  // Simulated listener, in spoken order.
  let playhead = 0;
  for (const c of chunks) {
    if (c.firstByte === null || c.clipSec === null) continue;
    c.backlogAtArrival = +Math.max(0, playhead - c.firstByte).toFixed(2);
    c.playStart = +Math.max(c.firstByte, playhead).toFixed(2);
    c.playEnd = +(c.playStart + c.clipSec).toFixed(2);
    playhead = c.playEnd;
    if (c.speechEnd !== null) c.lag = +(c.playStart - c.speechEnd).toFixed(2);
  }

  const lags = chunks.map((c) => c.lag).filter((x): x is number => x !== null);
  const backlogs = chunks.map((c) => c.backlogAtArrival).filter((x): x is number => x !== null);
  const stage = (f: (c: ChunkTiming) => number | null) => {
    const xs = chunks.map(f).filter((x): x is number => x !== null);
    const r = (x: number | null) => (x === null ? null : +x.toFixed(2));
    return { p50: r(pct(xs, 50)), p95: r(pct(xs, 95)) };
  };
  const outputSec = chunks.reduce((n, c) => n + (c.clipSec ?? 0), 0);
  // Backlog trend: compare the last third of the run with the first third.
  const third = Math.max(1, Math.floor(backlogs.length / 3));
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const metrics = {
    label,
    direction: summary.direction,
    chunks: chunks.length,
    matchedToSpeech: chunks.filter((c) => c.speechEnd !== null).length,
    sttClockResets: clockResets,
    lag: { p50: pct(lags, 50), p95: pct(lags, 95), max: lags.length ? Math.max(...lags) : null },
    stages: {
      speechEndToSttFinal: stage((c) => (c.speechEnd !== null && c.sttFinal !== null ? c.sttFinal - c.speechEnd : null)),
      sttFinalToTranslated: stage((c) => (c.sttFinal !== null ? c.translated - c.sttFinal : null)),
      translatedToFirstByte: stage((c) => (c.firstByte !== null ? c.firstByte - c.translated : null)),
      firstByteToPlayStart: stage((c) => (c.playStart !== null && c.firstByte !== null ? c.playStart - c.firstByte : null)),
    },
    backlog: {
      max: backlogs.length ? Math.max(...backlogs) : null,
      firstThirdAvg: +avg(backlogs.slice(0, third)).toFixed(2),
      lastThirdAvg: +avg(backlogs.slice(-third)).toFixed(2),
    },
    sourceSec: summary.audioSeconds,
    outputSec: +outputSec.toFixed(1),
    outputToSourceRatio: summary.audioSeconds ? +(outputSec / summary.audioSeconds).toFixed(2) : null,
  };
  return { dir, metrics, chunks };
}

function sideBySide(label: string, chunks: ChunkTiming[]): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const rows = chunks.map(
    (c) => `| ${c.seq} | ${cell(c.source)} | ${cell(c.translation)} | ${c.lag ?? ''} |`,
  );
  return [
    `# ${label}: source | translation`,
    '',
    'Lag is seconds from the end of the spoken sentence to when a listener starts hearing it.',
    '',
    '| # | Source | Translation | Lag (s) |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

function main(): void {
  const label = arg('--label');
  if (!label) throw new Error('--label is required');
  const run = analyse(label);
  fs.writeFileSync(path.join(run.dir, 'timing.json'), JSON.stringify({ metrics: run.metrics, chunks: run.chunks }, null, 2));
  fs.writeFileSync(path.join(run.dir, 'side-by-side.md'), sideBySide(label, run.chunks));
  console.log(JSON.stringify(run.metrics, null, 2));

  const against = arg('--against');
  if (against) {
    const base = analyse(against).metrics;
    const m = run.metrics;
    const row = (name: string, a: unknown, b: unknown) => console.log(`${name.padEnd(28)} ${String(a).padStart(8)} → ${String(b).padStart(8)}`);
    console.log(`\n${against} → ${label}`);
    row('lag p50 (s)', base.lag.p50, m.lag.p50);
    row('lag p95 (s)', base.lag.p95, m.lag.p95);
    row('max backlog (s)', base.backlog.max, m.backlog.max);
    row('backlog last third avg (s)', base.backlog.lastThirdAvg, m.backlog.lastThirdAvg);
    row('output / source', base.outputToSourceRatio, m.outputToSourceRatio);
  }
  console.log(`\nwrote ${path.join(run.dir, 'timing.json')} and side-by-side.md`);
}

main();
