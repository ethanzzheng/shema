/**
 * Cantonese on Scribe: the real-time connection (against a local stand-in for
 * ElevenLabs), and the Chinese clean-up around it — lone acknowledgments, the
 * "(empty response)" placeholder, and Traditional characters for display.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket } from 'ws';
import { ScribeSTT } from '../src/stt-scribe';
import type { TranscriptEvent } from '../src/stt';
import { stripAcknowledgmentsZh, stripLeadingScrapZh } from '../src/text-zh';
import { isPlaceholderOutput, stripMetaPreamble } from '../src/translation';
import { toHongKongScript } from '../src/zh-script';
import { resolveSttProvider, useBoundaryOracle } from '../src/direction-config';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
}

/** Fake Scribe: records each connection's URL and audio messages. */
async function fakeScribe(opts: { start?: boolean } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  const conns: { ws: WebSocket; url: string; msgs: any[] }[] = [];
  wss.on('connection', (ws, req) => {
    const c = { ws, url: req.url ?? '', msgs: [] as any[] };
    conns.push(c);
    ws.on('message', (d) => c.msgs.push(JSON.parse(d.toString())));
    if (opts.start !== false) ws.send(JSON.stringify({ message_type: 'session_started', session_id: 's' }));
  });
  const port = (wss.address() as { port: number }).port;
  after(() => {
    for (const c of conns) c.ws.terminate();
    wss.close();
  });
  return { wss, conns, url: `ws://127.0.0.1:${port}/v1/speech-to-text/realtime` };
}

const made: ScribeSTT[] = [];
after(() => made.forEach((s) => s.disconnect()));

function scribe(url: string, events: TranscriptEvent[], extra: Partial<ConstructorParameters<typeof ScribeSTT>[0]> = {}) {
  const s = new ScribeSTT({
    apiKey: 'k', languageCode: 'yue', vadSilenceSecs: 0.5, noVerbatim: true,
    keyterms: ['圣灵', '腓立比书'], baseUrl: url,
    onTranscript: (e) => events.push(e), onError: () => {}, onStatusChange: () => {},
    ...extra,
  });
  made.push(s);
  return s;
}

test('Scribe: settings and keyterms go in the URL; audio held until the session starts', async () => {
  const srv = await fakeScribe();
  const events: TranscriptEvent[] = [];
  const s = scribe(srv.url, events);
  s.sendAudio(Buffer.alloc(3200, 1)); // before connect: dropped, not running
  s.connect();
  s.sendAudio(Buffer.alloc(3200, 2)); // during the handshake: held
  await until(() => srv.conns[0]?.msgs.length === 1);
  const u = new URL(srv.conns[0].url, 'ws://x');
  assert.equal(u.searchParams.get('language_code'), 'yue');
  assert.equal(u.searchParams.get('vad_silence_threshold_secs'), '0.5');
  assert.equal(u.searchParams.get('no_verbatim'), 'true');
  assert.deepEqual(u.searchParams.getAll('keyterms'), ['圣灵', '腓立比书']);
  const m = srv.conns[0].msgs[0];
  assert.equal(m.message_type, 'input_audio_chunk');
  assert.equal(Buffer.from(m.audio_base_64, 'base64')[0], 2);
  s.disconnect();
  srv.wss.close();
});

test('Scribe: a commit becomes a final with word times, transformed for display', async () => {
  const srv = await fakeScribe();
  const events: TranscriptEvent[] = [];
  const s = scribe(srv.url, events, { transform: toHongKongScript });
  s.connect();
  await until(() => s.isConnected);
  for (let i = 0; i < 30; i++) s.sendAudio(Buffer.alloc(3200)); // 3 s
  await until(() => srv.conns[0].msgs.length === 30);
  srv.conns[0].ws.send(JSON.stringify({
    message_type: 'committed_transcript_with_timestamps', text: '圣灵与我们同在。',
    words: [{ text: '圣灵', start: 0.4, end: 0.9, type: 'word' }, { text: ' ', start: 0.9, end: 1, type: 'spacing' },
      { text: '同在。', start: 1.0, end: 1.6, type: 'word' }],
  }));
  await until(() => events.length === 1);
  const e = events[0];
  assert.equal(e.text, '聖靈與我們同在。');
  assert.equal(e.isFinal, true);
  assert.equal(e.firstWordSec, 0.4);
  assert.equal(e.lastWordEndSec, 1.6);
  // The silence after the last word runs to what was sent (3 s), capped at
  // 1.5 s past the word.
  assert.ok(Math.abs((e.audioEndSec ?? 0) - 3.0) < 1e-9);
  s.disconnect();
  srv.wss.close();
});

test('Scribe: finish() commits the last words and returns them', async () => {
  const srv = await fakeScribe();
  srv.wss.on('connection', (ws) =>
    ws.on('message', (d) => {
      if (JSON.parse(d.toString()).commit) {
        ws.send(JSON.stringify({ message_type: 'committed_transcript_with_timestamps', text: '阿们。', words: [] }));
      }
    }),
  );
  const s = scribe(srv.url, []);
  s.connect();
  await until(() => s.isConnected);
  assert.deepEqual(await s.finish(), ['阿们。']);
  assert.equal(s.isConnected, false);
  srv.wss.close();
});

test('Scribe: a refused session hands over to the fallback with the held audio', async () => {
  const srv = await fakeScribe({ start: false });
  srv.wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ message_type: 'auth_error', error: 'bad key' }));
  });
  let reason = '';
  const s: ScribeSTT = scribe(srv.url, [], { onUnavailable: (r) => (reason = r) });
  s.connect();
  s.sendAudio(Buffer.alloc(3200, 7));
  await until(() => reason !== '');
  assert.match(reason, /auth_error/);
  assert.equal(s.unsentAudio.length, 1);
  assert.equal(s.unsentAudio[0][0], 7);
  srv.wss.close();
});

test('Scribe: a dropped socket reconnects and resends audio not yet committed', async () => {
  const srv = await fakeScribe();
  const s = scribe(srv.url, []);
  s.connect();
  await until(() => s.isConnected);
  s.sendAudio(Buffer.alloc(32_000, 1)); // 0-1 s, committed below
  s.sendAudio(Buffer.alloc(32_000, 2)); // 1-2 s, not committed
  await until(() => srv.conns[0].msgs.length === 2);
  srv.conns[0].ws.send(JSON.stringify({
    message_type: 'committed_transcript_with_timestamps', text: '对',
    words: [{ text: '对', start: 0.2, end: 1.0, type: 'word' }],
  }));
  await wait(50);
  srv.conns[0].ws.terminate();
  await until(() => (srv.conns[1]?.msgs.length ?? 0) >= 1, 8000);
  const first = srv.conns[1].msgs[0];
  assert.equal(Buffer.from(first.audio_base_64, 'base64')[0], 2);
  // The new session is told what was said before.
  assert.equal(first.previous_text, '对');
  s.disconnect();
  srv.wss.close();
});

test('Scribe: past 10 s without a commit, commits itself at the next dip', async () => {
  const srv = await fakeScribe();
  const s = scribe(srv.url, []);
  s.connect();
  await until(() => s.isConnected);
  srv.conns[0].ws.send(JSON.stringify({ message_type: 'partial_transcript', text: '他讲了很久' }));
  await wait(30);
  const loud = () => {
    const b = Buffer.alloc(6400);
    for (let i = 0; i < 3200; i++) b.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
    return b;
  };
  for (let i = 0; i < 55; i++) s.sendAudio(loud()); // 11 s of speech, no pause
  s.sendAudio(Buffer.alloc(6400)); // a breath
  await until(() => srv.conns[0].msgs.length === 56);
  const commits = srv.conns[0].msgs.map((m, i) => (m.commit ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(commits, [55]);
});

test('acknowledgments: lone ones dropped, a leading one stripped, transitions kept', () => {
  assert.equal(stripAcknowledgmentsZh('对。'), '');
  assert.equal(stripAcknowledgmentsZh('係。 係，OK。'), '');
  assert.equal(stripAcknowledgmentsZh('对不对？'), '');
  assert.equal(stripAcknowledgmentsZh('对。他没有认输。'), '他没有认输。');
  assert.equal(stripAcknowledgmentsZh('對。對。佢話'), '佢話');
  assert.equal(stripAcknowledgmentsZh('好，下一张就看到他'), '好，下一张就看到他');
  assert.equal(stripAcknowledgmentsZh('是神的爱。'), '是神的爱。');
  assert.equal(stripAcknowledgmentsZh('阿们。'), '阿们。');
});

test('a scrap of the previous sentence is dropped from the front of a final', () => {
  assert.equal(stripLeadingScrapZh('。一定有说话，他说'), '一定有说话，他说');
  assert.equal(stripLeadingScrapZh('子。他非常开心'), '他非常开心');
  assert.equal(stripLeadingScrapZh('阿们。'), '阿们。');
  assert.equal(stripLeadingScrapZh('他说。'), '他说。');
});

test('placeholder output is recognised; real sentences are not', () => {
  for (const s of ['(empty response)', '[Empty response]', 'N/A', '…', '(No translation needed)']) {
    assert.equal(isPlaceholderOutput(s), true, s);
  }
  for (const s of ['None of us are worthy.', 'Silence fell over the crowd.', 'Amen.', 'Empty your hearts.']) {
    assert.equal(isPlaceholderOutput(s), false, s);
  }
});

test('translator commentary seen on Chinese runs is cut; sermon sentences are not', () => {
  assert.equal(stripMetaPreamble("I'll translate what is clear. He was thrilled."), 'He was thrilled.');
  assert.equal(
    stripMetaPreamble('The previous segment ended "as we receive you," and this one starts " ". So I translate it as "your word." your word, we ask the Holy Spirit to quiet our hearts.'),
    'your word, we ask the Holy Spirit to quiet our hearts.',
  );
  for (const t of ['In the next segment of his life, Paul preached.', 'I will translate it as best I can, he said.']) {
    assert.equal(stripMetaPreamble(t), t);
  }
});

test('Cantonese defaults to Scribe without the completeness check; env moves it back', () => {
  assert.equal(resolveSttProvider('yue-en', {}), 'scribe');
  assert.equal(useBoundaryOracle('yue-en', {}), false);
  assert.equal(resolveSttProvider('yue-en', { STT_PROVIDER_YUE: 'deepgram' }), 'deepgram');
  assert.equal(useBoundaryOracle('yue-en', { STT_PROVIDER_YUE: 'deepgram' }), true);
  assert.equal(resolveSttProvider('zh-en', {}), 'deepgram');
  assert.equal(useBoundaryOracle('zh-en', {}), true);
  assert.equal(resolveSttProvider('zh-en', { STT_PROVIDER_ZH: 'scribe' }), 'scribe');
  assert.equal(useBoundaryOracle('zh-en', { STT_PROVIDER_ZH: 'scribe' }), false);
  assert.equal(resolveSttProvider('ko-en', {}), 'deepgram');
  assert.equal(useBoundaryOracle('ko-en', {}), false);
});
