/**
 * Score a replay file: every chunk's live and replayed English is checked by a
 * judge model against the source, with the neighbouring chunks for context.
 *
 * Usage:
 *   npx tsx evals/judge-translations.ts --run cbcgl-1011 --replay v2 [--cols live,replay]
 *
 * Prints counts per issue type for each column and writes
 * judge-<replay>.jsonl next to the replay file.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { findRunDir } from './recordings';

const JUDGE_MODEL = process.env.JUDGE_MODEL || 'claude-opus-5-5';
const TYPES = ['addition', 'omission', 'repeat', 'meaning', 'fragment'] as const;

function arg(flag: string, dflt = ''): string {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
}

const SYSTEM_FOR = (SRC: string) => `You audit a live machine interpretation of a ${SRC} church sermon into English. The ${SRC} came from speech recognition and contains homophone mistakes; judge against what the pastor evidently MEANT, not the literal garble. The sermon was cut into segments at pauses, so a segment may begin or end mid-sentence; that alone is not an error.

For the TARGET segment only, report these issues:
- addition: the English says something the ${SRC} segment does not contain (e.g. finishes a Bible verse the pastor had not reached, invents a phrase for a garble, completes a thought from the sermon's theme). Rendering a quoted verse in standard Bible wording is NOT an addition if the pastor said that part.
- omission: a clause with real content in the ${SRC} is missing from the English (dropping filler or false starts is fine).
- repeat: the English restates content the PREVIOUS English segment already said.
- meaning: the English states something wrong or opposite to what the pastor meant.
- fragment: the English is a stand-alone sentence that would mislead a listener because it was cut (e.g. a dangling modifier attaching to the wrong thing, an invented question). A plain clipped clause is not a fragment.

Be strict but fair; minor stylistic choices are not issues. Reply with ONLY a JSON object: {"issues":["addition"|"omission"|"repeat"|"meaning"|"fragment",...],"note":"<one short sentence, empty if none>"}`;

interface Line { seq: number; source: string; live: string; replay: string }

async function main(): Promise<void> {
  const run = arg('--run');
  const name = arg('--replay', 'replay');
  const cols = arg('--cols', 'live,replay').split(',') as ('live' | 'replay')[];
  // Judging is itself stochastic; --trial lets a replay be judged more than once.
  const trial = arg('--trial');
  const dir = findRunDir(run);
  // The judge is told the source language; the run's folder names it.
  const SRC = dir.includes('/korean/') ? 'Korean' : dir.includes('/english/') ? 'English' : 'Mandarin';
  const SYSTEM = SYSTEM_FOR(SRC);
  const lines: Line[] = fs.readFileSync(path.join(dir, `replay-${name}.jsonl`), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 4 });

  const results: Record<string, unknown>[] = [];
  const jobs: (() => Promise<void>)[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const col of cols) {
      jobs.push(async () => {
        const prev = lines.slice(Math.max(0, i - 2), i);
        const next = lines[i + 1];
        const L = lines[i];
        const prompt =
          prev.map((p) => `PREVIOUS ${SRC}: ${p.source}\nPREVIOUS English: ${p[col]}`).join('\n\n') +
          `\n\nTARGET ${SRC}: ${L.source}\nTARGET English: ${L[col]}` +
          (next ? `\n\n(NEXT ${SRC}, for context only: ${next.source})` : '');
        const r = await client.messages.create({ model: JUDGE_MODEL, max_tokens: 300, system: SYSTEM, messages: [{ role: 'user', content: prompt }] });
        const text = r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
        let parsed: { issues: string[]; note: string } = { issues: [], note: 'unparsed' };
        try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { /* keep default */ }
        results.push({ seq: L.seq, col, ...parsed });
      });
    }
  }
  let idx = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (idx < jobs.length) await jobs[idx++](); }));

  results.sort((a, b) => (a.seq as number) - (b.seq as number));
  fs.writeFileSync(path.join(dir, `judge-${name}${trial ? `-t${trial}` : ''}.jsonl`), results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (const col of cols) {
    const rs = results.filter((r) => r.col === col);
    const counts = Object.fromEntries(TYPES.map((t) => [t, rs.filter((r) => (r.issues as string[]).includes(t)).length]));
    const flagged = rs.filter((r) => (r.issues as string[]).length > 0).length;
    console.log(`${col.padEnd(7)} segments ${rs.length}  flagged ${flagged}  ${JSON.stringify(counts)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
