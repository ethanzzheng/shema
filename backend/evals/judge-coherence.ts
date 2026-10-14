/**
 * Judge a translation the way the congregation hears it: as one continuous
 * stream of English, not segment by segment. judge-translations.ts checks each
 * segment against its source; this checks whether consecutive segments,
 * spoken one after another, can be FOLLOWED — the thing chunking decides.
 *
 * Usage:
 *   npx tsx evals/judge-coherence.ts --run cbcgl-1011-v3 --replay live [--col replay] [--window 10] [--trial 1]
 *
 * The English is cut into windows of --window segments. For each window the
 * judge sees the Mandarin too (so it can tell a translator's break from the
 * pastor's own), scores followability 1-5 and lists problems by seq.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { findRunDir } from './recordings';

const JUDGE_MODEL = process.env.JUDGE_MODEL || 'claude-opus-5-5';
const TYPES = ['broken', 'jump', 'repeat', 'garble', 'filler'] as const;

function arg(flag: string, dflt = ''): string {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
}

const SYSTEM_FOR = (SRC: string) => `You are an English-speaking churchgoer listening to a live machine interpretation of a ${SRC} sermon through earphones. The English below is exactly what you hear, segment after segment, with a short pause between segments. The ${SRC} source is shown only so you can tell the interpreter's problems from the pastor's own (a pastor who trails off or jumps topic is not the interpreter's fault).

Judge how well you can FOLLOW the English. Report problems the interpreter caused:
- broken: a sentence is split across segments so that a segment ends or begins in a way you cannot follow (a dangling clause that never resolves, a continuation you cannot attach to anything).
- jump: a segment does not connect to what came before although the ${SRC} does.
- repeat: you hear the same content twice across segments.
- garble: a phrase that makes no sense in English.
- filler: verbal tics or filler that make it tiresome to listen to (repeated "right?", "so", "you know").

Score the window 1-5: 5 = flows like a fluent human interpreter, 4 = easy to follow with small bumps, 3 = followable with effort, 2 = often lost, 1 = cannot follow.

Reply with ONLY a JSON object: {"score":<1-5>,"problems":[{"seq":<number>,"type":"broken"|"jump"|"repeat"|"garble"|"filler","note":"<short>"}]}`;

interface Line { seq: number; source: string; live: string; replay: string }

async function main(): Promise<void> {
  const run = arg('--run');
  const name = arg('--replay', 'replay');
  const col = arg('--col', 'replay') as 'live' | 'replay';
  const size = Number(arg('--window', '10'));
  const trial = arg('--trial');
  const dir = findRunDir(run);
  // The judge is told the source language; the run's folder names it.
  const SRC = dir.includes('/korean/') ? 'Korean' : dir.includes('/english/') ? 'English' : 'Mandarin';
  const SYSTEM = SYSTEM_FOR(SRC);
  const lines: Line[] = fs.readFileSync(path.join(dir, `replay-${name}.jsonl`), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 4 });

  const windows: Line[][] = [];
  for (let i = 0; i < lines.length; i += size) windows.push(lines.slice(i, i + size));
  const results: { start: number; score: number; problems: { seq: number; type: string; note: string }[] }[] = [];
  let idx = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (idx < windows.length) {
      const w = windows[idx++];
      const prompt =
        `${SRC} (reference only):\n${w.map((l) => `[${l.seq}] ${l.source}`).join('\n')}\n\n` +
        `English as heard:\n${w.map((l) => `[${l.seq}] ${l[col]}`).join('\n')}`;
      const r = await client.messages.create({ model: JUDGE_MODEL, max_tokens: 1200, system: SYSTEM, messages: [{ role: 'user', content: prompt }] });
      const text = r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
      let parsed = { score: 0, problems: [] as { seq: number; type: string; note: string }[] };
      try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { /* keep default */ }
      results.push({ start: w[0].seq, ...parsed });
    }
  }));
  results.sort((a, b) => a.start - b.start);
  fs.writeFileSync(
    path.join(dir, `coherence-${name}-${col}${trial ? `-t${trial}` : ''}.jsonl`),
    results.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  const scored = results.filter((r) => r.score > 0);
  const mean = scored.reduce((a, r) => a + r.score, 0) / Math.max(1, scored.length);
  const probs = results.flatMap((r) => r.problems);
  const counts = Object.fromEntries(TYPES.map((t) => [t, probs.filter((p) => p.type === t).length]));
  console.log(`${name}/${col}: windows ${results.length}  mean score ${mean.toFixed(2)}  problems ${probs.length}  ${JSON.stringify(counts)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
