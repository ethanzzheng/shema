/**
 * Feed an audio file into a room as if it were a microphone.
 *
 * The desk and the whole pipeline are otherwise only reachable with a real mic,
 * which makes them awkward to exercise — you cannot script a sermon into a
 * laptop. This opens a broadcaster socket, decodes the file to the same PCM the
 * browser sends (16 kHz mono Int16LE) and streams it in 200 ms frames, paced in
 * real time so the chunker and translator see the timing they would in a service.
 *
 *   npx tsx scripts/replay-audio.ts --file ../frontend/public/demo/sample-sermon.mp3 \
 *     --room hanmaum --token "$JWT"
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const SAMPLE_RATE = 16_000;
const FRAME_MS = 200;
const BYTES_PER_FRAME = (SAMPLE_RATE / 1000) * FRAME_MS * 2; // Int16 = 2 bytes

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined && fallback === undefined) throw new Error(`--${name} is required`);
  return v ?? fallback!;
}

const file = arg('file');
const room = arg('room', 'hanmaum');
const host = arg('host', 'ws://localhost:3001');
const direction = arg('direction', 'ko-en');
const mode = arg('mode', 'fast');
const token = arg('token', '');

/** Decode anything ffmpeg understands into the exact PCM the browser produces. */
function decode(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', path,
      '-f', 's16le', '-acodec', 'pcm_s16le',
      '-ar', String(SAMPLE_RATE), '-ac', '1',
      'pipe:1',
    ]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', reject);
    ff.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().trim()}`)),
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pcm = await decode(file);
  const frames = Math.ceil(pcm.length / BYTES_PER_FRAME);
  console.log(`[replay] ${file} → ${(pcm.length / 2 / SAMPLE_RATE).toFixed(1)}s, ${frames} frames`);

  const ws = new WebSocket(`${host}/?room=${encodeURIComponent(room)}&role=broadcaster`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  console.log(`[replay] connected to ${room}`);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'translation') console.log(`[${msg.direction ?? ''}] ${msg.source ?? ''} → ${msg.text ?? ''}`);
      else if (msg.type === 'error') console.error('[replay] server error:', msg.message);
    } catch { /* non-JSON control frames are not interesting here */ }
  });

  ws.send(JSON.stringify({ type: 'start', mode, direction, token: token || undefined }));
  await sleep(600); // let the STT connection come up before audio arrives

  // Pace against a wall clock rather than sleeping a flat 200 ms, so decode and
  // send cost does not make the stream drift slower than real time.
  const startedAt = Date.now();
  for (let i = 0; i < frames; i++) {
    const frame = pcm.subarray(i * BYTES_PER_FRAME, (i + 1) * BYTES_PER_FRAME);
    ws.send(frame);
    const due = startedAt + (i + 1) * FRAME_MS;
    const drift = due - Date.now();
    if (drift > 0) await sleep(drift);
  }
  console.log('[replay] audio sent; waiting for the tail to translate');

  await sleep(Number(arg('tail', '8000')));
  ws.send(JSON.stringify({ type: 'stop' }));
  await sleep(500);
  ws.close();
}

main().catch((err) => {
  console.error('[replay]', err.message);
  process.exit(1);
});
