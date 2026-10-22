/**
 * Stream a recording to ElevenLabs Scribe's real-time recognizer, at real-time
 * pace, and save what it commits as a recorded run that chunk-replay.ts can
 * replay. It answers one question: does Scribe's streaming mode keep the
 * accuracy its batch mode showed on Cantonese?
 *
 *   npx tsx evals/scribe-realtime.ts --label yue-holyword-scribe \
 *     --media ../recordings/cantonese/audio/youtube/DScUejo8oKI.m4a \
 *     --start 600 --duration 300 [--language yue] [--direction yue-en]
 *     [--vad-silence 0.5]   (seconds of silence before Scribe commits)
 *     [--no-verbatim]       (Scribe drops fillers and false starts itself)
 *     [--max-commit 10]     (commit ourselves past this much speech; 0 = off)
 *     [--keyterms a,b,c]
 *
 * Each commit becomes a final, stamped with when it arrived and where its
 * words sit in the audio, the same fields a Deepgram final carries. It uses
 * the production connection (src/stt-scribe.ts) but nothing else of the live
 * pipeline.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { ScribeSTT } from '../src/stt-scribe';
import { runsDir } from './recordings';

function arg(flag: string, dflt = ''): string {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
}

const label = arg('--label');
const media = path.resolve(arg('--media'));
const startSec = Number(arg('--start', '0'));
const durationSec = Number(arg('--duration', '300'));
const language = arg('--language', 'yue');
const direction = arg('--direction', 'yue-en');
if (!label || !arg('--media')) throw new Error('--label and --media are required');
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY is not set');

const SAMPLE_RATE = 16_000;
const CHUNK_MS = 100;
const BYTES_PER_CHUNK = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000;

const pcm = execFileSync('ffmpeg', [
  '-loglevel', 'error', '-ss', String(startSec), '-t', String(durationSec), '-i', media,
  '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-',
], { maxBuffer: 1 << 30 });

const vad = Number(arg('--vad-silence', '0.5'));
const noVerbatim = process.argv.includes('--no-verbatim');
const maxCommitSec = Number(arg('--max-commit', '10'));
const msgs: Record<string, unknown>[] = [];
let t0 = 0;
const clock = () => +((Date.now() - t0) / 1000).toFixed(3);

// The production connection (src/stt-scribe.ts), so the run measures what a
// church would get, commit cap included.
const stt = new ScribeSTT({
  apiKey: key,
  languageCode: language,
  vadSilenceSecs: vad,
  noVerbatim,
  maxCommitSec,
  keyterms: arg('--keyterms') ? arg('--keyterms').split(',') : [],
  onTranscript: (e) => {
    msgs.push({
      t: clock(), src: 'broadcaster', type: 'transcript', korean: e.text, isFinal: true, timestamp: e.timestamp,
      audioStartSec: e.audioStartSec, audioEndSec: e.audioEndSec, firstWordSec: e.firstWordSec, lastWordEndSec: e.lastWordEndSec,
    });
  },
  onError: (err) => console.error('[scribe]', err.message),
  onStatusChange: () => {},
});

async function main(): Promise<void> {
  stt.connect();
  t0 = Date.now();
  msgs.push({ t: 0, src: 'broadcaster', type: 'started', mode: 'smooth', direction });
  for (let off = 0, n = 0; off < pcm.length; off += BYTES_PER_CHUNK, n++) {
    const wait = t0 + n * CHUNK_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    stt.sendAudio(pcm.subarray(off, off + BYTES_PER_CHUNK));
    if (n % 600 === 0) console.log(`[scribe] ${Math.round((n * CHUNK_MS) / 1000)}s sent, ${msgs.length - 1} commits`);
  }
  await stt.finish(5000);
  const dir = path.join(runsDir(direction), label);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    label, media, room: label, mode: 'smooth', direction, audioSeconds: durationSec, audioStartT: 0,
    startSec, stt: 'scribe_v2_realtime', vadSilence: vad, noVerbatim, maxCommitSec, finishedAt: new Date().toISOString(),
  }, null, 2));
  console.log(`[scribe] ${msgs.length - 1} commits → ${dir}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
