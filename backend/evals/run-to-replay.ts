/**
 * Turn a pilot run into the replay file the judges read, so a live run can be
 * scored for quality without a separate replay step.
 *
 *   npx tsx evals/run-to-replay.ts --label <run>   (needs timing-report.ts first)
 *
 * Writes replay-live.jsonl ({seq, source, live, replay}) into the run folder;
 * live and replay are both the English the listener heard. Then:
 *   npx tsx evals/judge-translations.ts --run <run> --replay live --cols live
 *   npx tsx evals/judge-coherence.ts --run <run> --replay live --col live
 */
import fs from 'fs';
import path from 'path';
import { findRunDir } from './recordings';

const i = process.argv.indexOf('--label');
const label = i >= 0 ? process.argv[i + 1] : '';
if (!label) throw new Error('--label is required');
const dir = findRunDir(label);
const { chunks } = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'));
const lines = chunks.map((c: { seq: number; source: string; translation: string }) =>
  JSON.stringify({ seq: c.seq, source: c.source, live: c.translation, replay: c.translation }),
);
fs.writeFileSync(path.join(dir, 'replay-live.jsonl'), lines.join('\n') + '\n');
console.log(`wrote ${lines.length} lines to ${path.join(dir, 'replay-live.jsonl')}`);
