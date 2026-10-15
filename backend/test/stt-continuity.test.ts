/**
 * Audio continuity across Deepgram connections.
 *
 * Audio arriving while the socket was not open used to be dropped: the
 * handshake at the start of a broadcast, and the back-off plus handshake of
 * every reconnect mid-sermon. Words went missing with nothing in the logs to
 * say so. These tests run DeepgramSTT against a local stand-in server and
 * check the bytes it actually receives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket } from 'ws';
import { DeepgramSTT } from '../src/stt';

const BPS = 32_000; // linear16 mono 16 kHz

/** A recognisable chunk: every byte is `tag`, so order and cuts are visible. */
const chunk = (tag: number, sec = 0.2) => Buffer.alloc(Math.round(sec * BPS), tag);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
}

/** Fake Deepgram: records the audio each connection received. */
async function fakeDeepgram() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  const conns: { ws: WebSocket; audio: Buffer[] }[] = [];
  wss.on('connection', (ws) => {
    const c = { ws, audio: [] as Buffer[] };
    conns.push(c);
    ws.on('message', (data, isBinary) => { if (isBinary) c.audio.push(data as Buffer); });
  });
  const port = (wss.address() as { port: number }).port;
  return { wss, conns, url: `ws://127.0.0.1:${port}/v1/listen` };
}

function makeStt(url: string) {
  const finals: string[] = [];
  const stt = new DeepgramSTT({
    apiKey: 'test',
    baseUrl: url,
    onTranscript: (e) => { if (e.isFinal) finals.push(e.text); },
    onError: () => {},
    onStatusChange: () => {},
  });
  return { stt, finals };
}

const final = (text: string, start: number, duration: number) =>
  JSON.stringify({ type: 'Results', is_final: true, start, duration, channel: { alternatives: [{ transcript: text }] } });

test('audio sent before the socket opens is delivered, in order, once it does', async () => {
  const dg = await fakeDeepgram();
  const { stt } = makeStt(dg.url);
  stt.connect();
  // The pastor is already speaking during the handshake.
  stt.sendAudio(chunk(1));
  stt.sendAudio(chunk(2));
  await until(() => dg.conns.length === 1 && stt.isConnected);
  stt.sendAudio(chunk(3));
  await until(() => dg.conns[0].audio.length === 3);
  assert.deepEqual(dg.conns[0].audio.map((b) => b[0]), [1, 2, 3]);
  stt.disconnect();
  dg.wss.close();
});

test('with no drop, Deepgram receives exactly the audio it was sent', async () => {
  // The path every healthy service takes must be untouched by the new code.
  const dg = await fakeDeepgram();
  const { stt } = makeStt(dg.url);
  stt.connect();
  await until(() => stt.isConnected);
  const sent: Buffer[] = [];
  for (let i = 0; i < 150; i++) { // 30s, past the replay window
    const c = chunk(i % 250);
    sent.push(c);
    stt.sendAudio(c);
  }
  await until(() => dg.conns[0].audio.length === 150);
  assert.ok(Buffer.concat(dg.conns[0].audio).equals(Buffer.concat(sent)));
  assert.equal(dg.conns.length, 1);
  stt.disconnect();
  dg.wss.close();
});

test('a drop re-sends only what was never finalized, then the gap, with nothing lost or repeated', async () => {
  const dg = await fakeDeepgram();
  const { stt, finals } = makeStt(dg.url);
  stt.connect();
  await until(() => stt.isConnected);

  // Ten chunks of 0.2s (2s of audio). Deepgram finalizes the first 1.1s:
  // that ends inside chunk 6, so the replay must start mid-chunk.
  for (let i = 1; i <= 10; i++) stt.sendAudio(chunk(i));
  await until(() => dg.conns[0].audio.length === 10);
  dg.conns[0].ws.send(final('첫 문장입니다', 0, 1.1));
  await until(() => finals.length === 1);

  // The connection dies; the pastor keeps talking through the reconnect.
  dg.conns[0].ws.terminate();
  await until(() => !stt.isConnected);
  for (let i = 11; i <= 13; i++) stt.sendAudio(chunk(i));

  await until(() => dg.conns.length === 2 && stt.isConnected, 8000);
  await wait(100);
  const got = Buffer.concat(dg.conns[1].audio);

  // Expected: chunk 6 from 0.1s in (1.1s - 1.0s), chunks 7-10, then 11-13.
  const expected = Buffer.concat([
    chunk(6).subarray(0.1 * BPS),
    ...[7, 8, 9, 10, 11, 12, 13].map((t) => chunk(t)),
  ]);
  assert.equal(got.length, expected.length, `received ${got.length / BPS}s, expected ${expected.length / BPS}s`);
  assert.ok(got.equals(expected), 'replayed audio is not exactly the unfinalized tail plus the gap');

  // Finals on the new socket are on its own clock, starting at 0 again, and
  // must not be mistaken for re-sends of the old one.
  dg.conns[1].ws.send(final('두 번째 문장입니다', 0, 1.5));
  await until(() => finals.length === 2);
  stt.disconnect();
  dg.wss.close();
});

test('held audio is bounded, so a long outage cannot grow memory without limit', async () => {
  const { stt } = makeStt('ws://127.0.0.1:9/v1/listen'); // nothing listens here
  stt.connect();
  for (let i = 0; i < 600; i++) stt.sendAudio(chunk(1)); // 120s
  const held = (stt as unknown as { held: Buffer[] }).held.reduce((n, b) => n + b.length, 0) / BPS;
  assert.ok(held <= 20.001, `held ${held}s`);
  stt.disconnect();
});
