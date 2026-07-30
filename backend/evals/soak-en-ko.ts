/**
 * Latency + quality soak for the en-ko pipeline (npm run soak:en-ko).
 *
 * Pipes a scripted sermon passage through the REAL chunker + translator as
 * 10 successive STT finals with realistic Deepgram cadence — including a
 * pause-punctuation artifact ("...and."), an elliptical auxiliary ending, a
 * comma-chained run-on (exercises clause relief), and a stranded-preposition
 * rhetorical question. Prints a stage-by-stage latency table so timing
 * changes are measurable run-over-run, then asserts quality: 하십시오체
 * register, Hangul script, no meta-commentary, no invented content, and
 * consistent terminology for the recurring term.
 *
 *   npm run soak:en-ko           # chunker + translation stages
 *   npm run soak:en-ko -- --tts  # + real TTS first-byte/stream stages
 */

import 'dotenv/config';
import { KoreanChunker } from '../src/chunker';
import { ClaudeTranslator, looksLikeMetaCommentary } from '../src/translation';
import { ElevenLabsTTS } from '../src/tts';
import { resolveTtsModelId, resolveTtsVoiceId } from '../src/direction-config';
import { registerViolations, hangulRatio, strayEnglishWords } from './run-en-ko';

const TERM_CANDIDATES = ['초대 교인', '초대 그리스도인', '초기 그리스도인', '초기 교인', '초대교회 성도'];

// Successive STT finals with delays mimicking Deepgram's cadence.
const FRAGMENTS: { text: string; delayMs: number }[] = [
  { text: 'Good morning, church.', delayMs: 0 },
  { text: 'Today I want to talk about the early Christians and.', delayMs: 1800 }, // pause-punctuation artifact
  { text: 'how they lived out their faith in a hostile world.', delayMs: 1500 },
  { text: 'The early Christians shared everything they had, and they cared for the poor among them, and they prayed together in their homes every single day', delayMs: 2400 },
  { text: 'and they loved their enemies, and they forgave the people who persecuted them, and the world around them could not explain what it was seeing', delayMs: 2400 }, // run-on → clause relief
  { text: 'Did they suffer for it? Yes, he says, they did.', delayMs: 1800 }, // elliptical auxiliary ending
  { text: 'So church, what are you waiting for?', delayMs: 1500 }, // stranded preposition
  { text: 'Turn with me to Acts chapter 2.', delayMs: 1500 },
  { text: 'Um, uh, you know,', delayMs: 1200 }, // filler
  { text: 'The early Christians turned the world upside down.', delayMs: 1500 },
];

interface ChunkRecord {
  seq: number;
  source: string;
  output: string;
  waitMs: number;
  translateMs: number;
  ttsFirstByteMs: number | null;
  ttsStreamMs: number | null;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY required (soak drives the real translator).');
    process.exit(1);
  }
  const withTts = process.argv.includes('--tts');
  const mode = process.argv.includes('--fast') ? 'fast' : 'smooth';

  const translator = new ClaudeTranslator(process.env.ANTHROPIC_API_KEY, undefined, 'en-ko');
  const tts = withTts
    ? new ElevenLabsTTS({
        apiKey: process.env.ELEVENLABS_API_KEY!,
        voiceId: resolveTtsVoiceId('en-ko') ?? '',
        modelId: resolveTtsModelId('en-ko'),
      })
    : null;
  if (withTts && !resolveTtsVoiceId('en-ko')) {
    console.error('--tts needs ELEVENLABS_VOICE_ID_KO set.');
    process.exit(1);
  }

  const records: ChunkRecord[] = [];
  const chunker = new KoreanChunker({
    mode,
    direction: 'en-ko',
    nextSeq: (() => { let s = 0; return () => ++s; })(),
    onChunk: async (text, seq, waitMs) => {
      const t0 = Date.now();
      let output = '';
      try {
        output = (await translator.translate(text)).sermon_translation;
      } catch (err) {
        output = `[soak-error: ${(err as Error).message}]`;
      }
      const translateMs = Date.now() - t0;
      const rec: ChunkRecord = { seq, source: text, output, waitMs, translateMs, ttsFirstByteMs: null, ttsStreamMs: null };
      if (tts && output && output !== '[Translation error]') {
        const t1 = Date.now();
        let firstByteAt = 0;
        try {
          await tts.synthesiseStream(output, () => { if (!firstByteAt) firstByteAt = Date.now(); });
          rec.ttsFirstByteMs = firstByteAt ? firstByteAt - t1 : null;
          rec.ttsStreamMs = firstByteAt ? Date.now() - firstByteAt : null;
        } catch (err) {
          console.warn(`  tts failed for seq ${seq}:`, (err as Error).message);
        }
      }
      records.push(rec);
    },
  });

  console.log(`Soaking ${FRAGMENTS.length} STT finals through the en-ko chunker+translator (mode=${mode}${withTts ? ', +tts' : ''})...\n`);
  const startedAt = Date.now();
  for (const f of FRAGMENTS) {
    if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
    await chunker.feed(f.text, true);
  }
  await chunker.forceFlush();
  // Straggler timers (graded patience can outlive the feed loop).
  await new Promise((r) => setTimeout(r, 500));
  await chunker.forceFlush();
  const wallMs = Date.now() - startedAt;

  records.sort((a, b) => a.seq - b.seq);

  // ── Latency table ──────────────────────────────────────────────────────────
  console.log('seq  wait     translate  tts-1st   stream    output');
  for (const r of records) {
    const pad = (v: number | null, w: number) => String(v === null ? '-' : `${v}ms`).padEnd(w);
    console.log(
      `${String(r.seq).padEnd(4)} ${pad(r.waitMs, 8)} ${pad(r.translateMs, 10)} ${pad(r.ttsFirstByteMs, 9)} ${pad(r.ttsStreamMs, 9)} ${r.output.slice(0, 46)}`,
    );
  }
  const avg = (vals: (number | null)[]) => {
    const xs = vals.filter((v): v is number => v !== null);
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  };
  console.log(
    `\navg: wait ${avg(records.map((r) => r.waitMs))}ms · translate ${avg(records.map((r) => r.translateMs))}ms` +
      (withTts ? ` · tts-first-byte ${avg(records.map((r) => r.ttsFirstByteMs))}ms · stream ${avg(records.map((r) => r.ttsStreamMs))}ms` : '') +
      ` · ${records.length} chunks in ${(wallMs / 1000).toFixed(1)}s wall`,
  );

  // ── Quality checks ─────────────────────────────────────────────────────────
  const outputs = records.map((r) => r.output).filter((o) => o && o !== '[Translation error]' && !o.startsWith('[soak-error'));
  const joined = outputs.join(' ');
  const regBad = outputs.flatMap((o) => registerViolations(o));
  const termOutputs = records.filter((r) => /early christians/i.test(r.source) && r.output && r.output !== '[Translation error]');
  const termShared = TERM_CANDIDATES.filter((t) => termOutputs.every((r) => r.output.includes(t)));
  const checks: Record<string, boolean> = {
    'chunks produced': records.length >= 5,
    'register 하십시오체': regBad.length === 0,
    'hangul script': hangulRatio(joined) >= 0.8 && strayEnglishWords(joined).length === 0,
    'no meta-commentary': outputs.every((o) => !looksLikeMetaCommentary(o)),
    'no invented city/content markers': !/고린도|에베소/.test(joined), // nothing in the script names a city
    'Acts reference in Korean': /사도행전\s*2장/.test(joined),
    'consistent terminology': termOutputs.length >= 2 && termShared.length > 0,
  };
  console.log('\n── Quality ──');
  let ok = true;
  for (const [k, v] of Object.entries(checks)) {
    console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
    if (!v) ok = false;
  }
  if (regBad.length) console.log('  register violations:', regBad.join(' | '));
  if (!checks['consistent terminology'])
    console.log('  term usage per output:', termOutputs.map((r) => `[${TERM_CANDIDATES.filter((t) => r.output.includes(t)).join(',') || 'none'}]`).join(' '));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
