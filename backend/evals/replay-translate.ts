/**
 * Re-translate the exact chunks of a recorded pilot run with the CURRENT
 * translator, in order, with the same rolling context and scripture-reference
 * tracking the broadcaster uses. Isolates translation from STT and chunking:
 * a prompt change can be judged against a real service in minutes instead of
 * an hour of real-time replay.
 *
 * Usage:
 *   npx tsx evals/replay-translate.ts --run cbcgl-1011 --out cbcgl-1011-v2 [--only 30-80] [--model claude-sonnet-5-5]
 *
 * Writes recordings/<language>/runs/<run>/replay-<out>.jsonl, one line per chunk:
 *   { seq, source, live, replay, ref, ms }
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ClaudeTranslator } from '../src/translation';
import { mergeReference, formatReference, detectReference, ScriptureRef } from '../src/scripture';
import { detectReferenceEn } from '../src/scripture-en';
import { detectReferenceZh } from '../src/scripture-zh';
import { getDirectionConfig, normalizeDirection } from '../src/direction-config';
import { findRunDir } from './recordings';
import { keepReadingZh } from '../src/verse-match-zh';

function arg(flag: string, dflt = ''): string {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
}

interface Chunk { seq: number; source: string; live: string }

function loadChunks(dir: string): { direction: string; chunks: Chunk[] } {
  let direction = 'ko-en';
  const bySeq = new Map<number, Chunk>();
  for (const line of fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.type === 'started' && m.direction) direction = m.direction;
    if (m.type === 'translation' && m.src === 'broadcaster' && typeof m.seq === 'number') {
      bySeq.set(m.seq, { seq: m.seq, source: m.korean, live: m.sermon });
    }
  }
  return { direction, chunks: [...bySeq.values()].sort((a, b) => a.seq - b.seq) };
}

async function main(): Promise<void> {
  const run = arg('--run');
  const out = arg('--out', 'replay');
  const only = arg('--only');
  const dir = findRunDir(run);
  const { direction: raw, chunks } = loadChunks(dir);
  const direction = normalizeDirection(raw);
  const cfg = getDirectionConfig(direction);
  const detect = cfg.sourceLang === 'en' ? detectReferenceEn : cfg.sourceLang === 'zh' ? detectReferenceZh : detectReference;
  const [lo, hi] = only ? only.split('-').map(Number) : [0, Infinity];

  // No church terms: a replay judges the prompt, not one church's glossary.
  const model = arg('--model') || undefined;
  const translator = new ClaudeTranslator(process.env.ANTHROPIC_API_KEY!, model, direction, 'replay', { churchTerms: [] });
  const outPath = path.join(dir, `replay-${out}.jsonl`);
  fs.writeFileSync(outPath, '');

  let currentRef: ScriptureRef | null = null;
  let refAge = 0;
  const skipped: { korean: string; english: string }[] = [];
  const t0 = Date.now();
  for (const c of chunks) {
    // Reference tracking runs over every chunk, so a window still sees the
    // reference announced before it, exactly as the live pipeline did.
    const detected = detect(c.source);
    if (detected) { currentRef = mergeReference(currentRef, detected); refAge = 0; }
    else if (direction === 'zh-en' && keepReadingZh(currentRef, c.source)) refAge = 0;
    else if (currentRef && ++refAge > 12) currentRef = null;
    if (c.seq < lo || c.seq > hi) {
      // Outside the window: seed context with what the live run said, so the
      // window starts from the same conversational state.
      skipped.push({ korean: c.source, english: c.live });
      translator.seedContext(skipped.slice(-8));
      continue;
    }
    const t = Date.now();
    const res = await translator.translate(c.source, currentRef, 1, c.seq);
    const line = { seq: c.seq, source: c.source, live: c.live, replay: res.sermon_translation, ref: formatReference(currentRef) || null, ms: Date.now() - t };
    fs.appendFileSync(outPath, JSON.stringify(line) + '\n');
    process.stdout.write(`\r[replay] ${c.seq}/${chunks[chunks.length - 1].seq}`);
  }
  const ms = fs.readFileSync(outPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).ms as number).sort((a, b) => a - b);
  const pct = (p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
  console.log(`\n[replay] wrote ${outPath} in ${((Date.now() - t0) / 1000).toFixed(0)}s; translation ms p50 ${pct(0.5)} p90 ${pct(0.9)} max ${ms[ms.length - 1]}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
