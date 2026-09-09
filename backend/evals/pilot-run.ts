/**
 * Full end-to-end pilot run against a recorded service.
 *
 * Drives a real audio file through a locally running backend exactly the way a
 * broadcast desk does — real Deepgram, real Claude, real ElevenLabs — while a
 * recording listener captures everything a congregant would receive. The point
 * is fidelity: the chunker's behaviour depends on the *timing* of Deepgram
 * finals, so the audio must be streamed at wall-clock speed. Anything faster
 * changes the very thing we are trying to measure.
 *
 * Artifacts land in evals/runs/<label>/ :
 *   messages.jsonl   every listener-visible message, with arrival offsets
 *   clips/seq-N.mp3  each sentence's audio, reassembled from its chunks
 *   summary.json     run metadata (counts, wall time, config)
 *
 * Usage:
 *   npx tsx evals/pilot-run.ts --label baseline [--media ../sermon_test.mp4]
 *                              [--room pilot] [--mode smooth] [--direction ko-en]
 *                              [--start 0] [--duration 0]   (seconds; 0 = whole file)
 *
 * Requires: a backend on ws://localhost:3001 with auth disabled, and ffmpeg.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

interface Args {
  label: string;
  media: string;
  room: string;
  mode: 'fast' | 'smooth';
  direction: string;
  backend: string;
  startSec: number;
  durationSec: number;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string, dflt: string): string => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
  };
  return {
    label: get('--label', 'run'),
    media: path.resolve(get('--media', path.join(__dirname, '../../sermon_test.mp4'))),
    room: get('--room', 'pilot'),
    mode: (get('--mode', 'smooth') === 'fast' ? 'fast' : 'smooth') as 'fast' | 'smooth',
    direction: get('--direction', 'ko-en'),
    backend: get('--backend', 'ws://localhost:3001/ws'),
    startSec: Number(get('--start', '0')),
    durationSec: Number(get('--duration', '0')),
  };
}

/** 16 kHz mono s16le is what the desk sends; 6400 bytes = 200 ms. */
const SAMPLE_RATE = 16000;
const CHUNK_BYTES = 6400;
const CHUNK_MS = 200;

function extractPcm(media: string, startSec: number, durationSec: number, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (startSec > 0) args.push('-ss', String(startSec));
    args.push('-i', media);
    if (durationSec > 0) args.push('-t', String(durationSec));
    args.push('-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', out);
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = parseArgs();
  const runDir = path.join(__dirname, 'runs', args.label);
  const clipDir = path.join(runDir, 'clips');
  fs.mkdirSync(clipDir, { recursive: true });

  // PCM extraction is deterministic, so cache it across runs of the same slice.
  const pcmPath = path.join(
    __dirname,
    'runs',
    `.pcm-${path.basename(args.media)}-${args.startSec}-${args.durationSec}.raw`,
  );
  if (!fs.existsSync(pcmPath)) {
    console.log('[pilot] extracting PCM (first run only)...');
    await extractPcm(args.media, args.startSec, args.durationSec, pcmPath);
  }
  const pcm = fs.readFileSync(pcmPath);
  const totalMs = (pcm.length / 2 / SAMPLE_RATE) * 1000;
  console.log(`[pilot] ${args.label}: ${(totalMs / 1000).toFixed(0)}s of audio → room "${args.room}"`);

  const messagesPath = path.join(runDir, 'messages.jsonl');
  const msgStream = fs.createWriteStream(messagesPath);
  const t0 = Date.now();
  const rel = (): number => +((Date.now() - t0) / 1000).toFixed(2);

  // ── Recording listener ──────────────────────────────────────────────────
  // Chunks are base64 per message; collect per seq and write one MP3 per
  // sentence so loudness can be measured offline.
  const clipParts = new Map<number, Buffer[]>();
  const counts = { translation: 0, audioStart: 0, audioEnd: 0, audioChunk: 0, error: 0, reconnects: 0 };
  let listenerClosed = false;

  const openListener = (): WebSocket => {
    const ws = new WebSocket(`${args.backend}?role=listener&room=${args.room}`);
    ws.on('message', (raw) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const type = m.type as string;
      if (type === 'audio_chunk') {
        counts.audioChunk++;
        const seq = m.seq as number;
        const buf = Buffer.from(m.data as string, 'base64');
        const parts = clipParts.get(seq);
        if (parts) parts.push(buf);
        // Log without the payload — the bytes go to the clip file instead.
        msgStream.write(JSON.stringify({ t: rel(), type, seq, bytes: buf.length }) + '\n');
        return;
      }
      if (type === 'audio_start') {
        counts.audioStart++;
        clipParts.set(m.seq as number, []);
      } else if (type === 'audio_end') {
        counts.audioEnd++;
        const seq = m.seq as number;
        const parts = clipParts.get(seq);
        if (parts) {
          fs.writeFileSync(path.join(clipDir, `seq-${String(seq).padStart(4, '0')}.mp3`), Buffer.concat(parts));
          clipParts.delete(seq);
        }
      } else if (type === 'translation') {
        counts.translation++;
      } else if (type === 'error') {
        counts.error++;
      }
      msgStream.write(JSON.stringify({ t: rel(), ...m }) + '\n');
    });
    ws.on('close', () => {
      if (listenerClosed) return;
      counts.reconnects++;
      msgStream.write(JSON.stringify({ t: rel(), type: 'LISTENER_WS_CLOSED' }) + '\n');
      setTimeout(() => openListener(), 1000);
    });
    ws.on('error', (e) => {
      msgStream.write(JSON.stringify({ t: rel(), type: 'LISTENER_WS_ERROR', message: e.message }) + '\n');
    });
    return ws;
  };
  let listener = openListener();
  await sleep(1000);

  // ── Broadcaster ─────────────────────────────────────────────────────────
  const bc = new WebSocket(`${args.backend}?role=broadcaster&room=${args.room}`);
  await new Promise<void>((resolve, reject) => {
    bc.once('open', () => resolve());
    bc.once('error', reject);
  });
  // The broadcaster socket is the only place the KOREAN source text appears
  // (`transcript.korean`, and `translation.korean` alongside the English).
  // Classifying a repeat as speaker emphasis vs pipeline duplication is
  // impossible without it, so record this side too.
  bc.on('message', (raw) => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.type === 'error') console.error('[pilot] backend error:', m.message);
    msgStream.write(JSON.stringify({ t: rel(), src: 'broadcaster', ...m }) + '\n');
  });
  bc.send(JSON.stringify({ type: 'start', mode: args.mode, direction: args.direction }));
  await sleep(600);

  // Stream at wall-clock speed, correcting drift against the schedule rather
  // than sleeping a flat 200ms (which would slowly fall behind real time and
  // change Deepgram's endpointing behaviour over a 47-minute run).
  const started = Date.now();
  let sent = 0;
  for (let off = 0; off < pcm.length; off += CHUNK_BYTES) {
    if (bc.readyState !== WebSocket.OPEN) {
      console.error('[pilot] broadcaster socket closed early — aborting');
      break;
    }
    bc.send(pcm.subarray(off, off + CHUNK_BYTES));
    sent++;
    const target = started + sent * CHUNK_MS;
    const lag = target - Date.now();
    if (lag > 0) await sleep(lag);
    if (sent % 300 === 0) {
      const pct = ((off / pcm.length) * 100).toFixed(0);
      console.log(
        `[pilot] ${pct}% · ${(sent * CHUNK_MS / 1000 / 60).toFixed(1)}min audio · ` +
          `${counts.translation} translations · ${counts.audioEnd} clips`,
      );
    }
  }

  // Let the tail of the pipeline drain (translation + TTS + streaming).
  console.log('[pilot] audio sent; draining pipeline...');
  await sleep(30000);
  bc.send(JSON.stringify({ type: 'stop' }));
  await sleep(3000);

  listenerClosed = true;
  listener.close();
  bc.close();
  msgStream.end();

  const summary = {
    label: args.label,
    media: args.media,
    room: args.room,
    mode: args.mode,
    direction: args.direction,
    audioSeconds: +(totalMs / 1000).toFixed(1),
    wallSeconds: +((Date.now() - t0) / 1000).toFixed(1),
    ...counts,
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('[pilot] done:', JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
