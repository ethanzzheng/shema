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
 *
 * Each commit becomes a final, stamped with when it arrived and where its
 * words sit in the audio, the same fields a Deepgram final carries. Nothing
 * here touches the live pipeline.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import WebSocket from 'ws';
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

const params = new URLSearchParams({
  model_id: 'scribe_v2_realtime',
  language_code: language,
  audio_format: 'pcm_16000',
  commit_strategy: 'vad',
  include_timestamps: 'true',
  ...(arg('--vad-silence') ? { vad_silence_threshold_secs: arg('--vad-silence') } : {}),
});
const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`, {
  headers: { 'xi-api-key': key },
});

interface Word { text: string; start: number; end: number; type: string }
const msgs: Record<string, unknown>[] = [];
let t0 = 0;
let sentSec = 0;
const clock = () => +((Date.now() - t0) / 1000).toFixed(3);
const counts: Record<string, number> = {};

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  counts[m.message_type] = (counts[m.message_type] ?? 0) + 1;
  if (m.message_type === 'committed_transcript_with_timestamps') {
    const words: Word[] = (m.words ?? []).filter((w: Word) => w.type === 'word');
    const text = String(m.text ?? '').trim();
    if (!text) return;
    const first = words[0]?.start;
    const last = words[words.length - 1]?.end;
    msgs.push({
      t: clock(), src: 'broadcaster', type: 'transcript', korean: text, isFinal: true,
      timestamp: Date.now(),
      audioStartSec: first, audioEndSec: Math.max(last ?? 0, Math.min(sentSec, (last ?? 0) + 1.5)),
      firstWordSec: first, lastWordEndSec: last,
    });
  } else if (/error|exceeded|limited|overflow|exhausted/.test(m.message_type)) {
    console.error('[scribe]', m.message_type, m.error ?? '');
  }
});

ws.on('open', async () => {
  t0 = Date.now();
  msgs.push({ t: 0, src: 'broadcaster', type: 'started', mode: 'smooth', direction });
  for (let off = 0, n = 0; off < pcm.length; off += BYTES_PER_CHUNK, n++) {
    const target = t0 + n * CHUNK_MS;
    const wait = target - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const chunk = pcm.subarray(off, off + BYTES_PER_CHUNK);
    ws.send(JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: chunk.toString('base64'),
      commit: off + BYTES_PER_CHUNK >= pcm.length,
      sample_rate: SAMPLE_RATE,
    }));
    sentSec += chunk.length / (SAMPLE_RATE * 2);
    if (n % 600 === 0) console.log(`[scribe] ${Math.round(sentSec)}s sent, ${msgs.length - 1} commits`);
  }
  // Let the last commit arrive.
  await new Promise((r) => setTimeout(r, 5000));
  ws.close();
});

ws.on('close', (code) => {
  const dir = path.join(runsDir(direction), label);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({
    label, media, room: label, mode: 'smooth', direction, audioSeconds: durationSec, audioStartT: 0,
    startSec, stt: 'scribe_v2_realtime', vadSilence: arg('--vad-silence') || null, finishedAt: new Date().toISOString(),
  }, null, 2));
  console.log(`[scribe] closed (${code}); ${msgs.length - 1} commits → ${dir}`, counts);
});
ws.on('error', (e) => console.error('[scribe] socket error:', e.message));
