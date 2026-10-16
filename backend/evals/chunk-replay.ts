/**
 * Re-run a recorded service through a CHUNKING variant in minutes, not in real
 * time.
 *
 * A pilot run records every STT final with its arrival time and where its
 * speech sits in the source audio. That is everything the chunker sees, so the
 * finals can be fed to the current chunker again under a simulated clock, with
 * any timing knobs overridden. The chunks it cuts are then translated for real
 * (in order, with the broadcaster's scripture tracking), and voice timing is
 * modelled from the source run: its measured seconds of English audio per
 * character and its translation → first-audio-byte delay.
 *
 * The result is written as a new run, <label>~<variant>, so timing-report.ts,
 * run-to-replay.ts and the judges work on it unchanged:
 *
 *   npx tsx evals/chunk-replay.ts --label yue-kwok-base --variant hold8 \
 *     --tuning '{"maxHoldMs":8000}' [--mode smooth] [--no-translate]
 *     [--direction yue-en] [--no-oracle] [--oracle-model <id>] [--no-pace]
 *     [--speed 1.08]
 *
 * --direction replays a run as another direction (Cantonese runs were
 * recorded on zh-en with zh-HK recognition). The completeness check runs for
 * real, at its measured latency on the simulated clock, and its answers are
 * cached in recordings/.oracle-cache.jsonl so variants see the same verdicts.
 * --no-pace turns off both the length rule and the backlog hint, for a
 * baseline; --speed scales the modelled voice length.
 *
 * Speech recognition is fixed by the recording, so this isolates chunking (and,
 * with --model, translation). Confirm a winner with a real-time pilot run.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { mock } from 'node:test';
import { execFileSync } from 'child_process';
import { KoreanChunker, type ModeConfig } from '../src/chunker';
import { ClaudeTranslator } from '../src/translation';
import { mergeReference, detectReference, type ScriptureRef } from '../src/scripture';
import { detectReferenceEn } from '../src/scripture-en';
import { detectReferenceZh } from '../src/scripture-zh';
import { keepReadingZh } from '../src/verse-match-zh';
import { getDirectionConfig, isChinese, normalizeDirection } from '../src/direction-config';
import { foldToSimplified } from '../src/zh-script';
import { findRunDir } from './recordings';
import crypto from 'crypto';
import { createBoundaryOracle, ORACLE_MODEL, oraclePrompt, type BoundaryOracle, type OracleVerdict } from '../src/boundary-oracle';
import { PACE_RULE } from '../src/translation';

function arg(flag: string, dflt = ''): string {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] ? a[i + 1] : dflt;
}
const has = (flag: string) => process.argv.includes(flag);

interface Msg { t: number; type: string; src?: string; [k: string]: unknown }

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** Seconds of English voice per character of translation, from the source run's real clips. */
function voiceRate(dir: string, msgs: Msg[]): number {
  const rates: number[] = [];
  for (const m of msgs) {
    if (m.src !== 'broadcaster' || m.type !== 'translation') continue;
    const clip = path.join(dir, 'clips', `seq-${String(m.seq).padStart(4, '0')}.mp3`);
    const text = String(m.sermon ?? '');
    if (!fs.existsSync(clip) || text.length < 20) continue;
    try {
      const d = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip]).toString());
      if (Number.isFinite(d)) rates.push(d / text.length);
    } catch { /* unreadable clip */ }
  }
  return rates.length ? median(rates) : 0.065; // ~15 characters a second
}

/** Translation broadcast → first audio byte, from the source run. */
function firstByteDelay(msgs: Msg[]): number {
  const translated = new Map<number, number>();
  const delays: number[] = [];
  for (const m of msgs) {
    if (m.src === 'broadcaster' && m.type === 'translation') translated.set(Number(m.seq), m.t);
    else if (m.src !== 'broadcaster' && m.type === 'audio_chunk' && translated.has(Number(m.seq))) {
      delays.push(m.t - translated.get(Number(m.seq))!);
      translated.delete(Number(m.seq));
    }
  }
  return delays.length ? median(delays) : 0.45;
}

async function main(): Promise<void> {
  const label = arg('--label');
  const variant = arg('--variant', 'replay');
  if (!label) throw new Error('--label is required');
  const tuning: Partial<ModeConfig> = JSON.parse(arg('--tuning', '{}'));
  const srcDir = findRunDir(label);
  const summary = JSON.parse(fs.readFileSync(path.join(srcDir, 'summary.json'), 'utf8'));
  const direction = normalizeDirection(arg('--direction') || summary.direction);
  const mode = (arg('--mode', summary.mode ?? 'smooth') === 'fast' ? 'fast' : 'smooth') as 'fast' | 'smooth';
  const msgs: Msg[] = fs.readFileSync(path.join(srcDir, 'messages.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const finals = msgs.filter((m) => m.src === 'broadcaster' && m.type === 'transcript' && m.isFinal);

  // Live translation time per chunk, recovered from the run: a translation
  // message carries its dispatch time as an epoch timestamp, and a final's
  // epoch timestamp against its run-clock arrival gives the clock offset.
  // The chunker lets only two translations run at once, so a slow one holds
  // later dispatches back; replaying with instant translation would cut
  // differently from the live run.
  const f0 = finals[0];
  const epochAtZero = Number(f0.timestamp) - f0.t * 1000;
  const liveLatency = median(
    msgs.filter((m) => m.src === 'broadcaster' && m.type === 'translation' && typeof m.timestamp === 'number')
      .map((m) => m.t * 1000 - (Number(m.timestamp) - epochAtZero))
      .filter((x) => x > 0 && x < 60_000),
  ) || 1500;

  // The completeness check, run for real but delivered on the simulated
  // clock after its real latency. The replay loop waits for every real call
  // before moving the clock, so simulated time stands still while it runs.
  const cfgDir = getDirectionConfig(direction);
  const pending = new Set<Promise<unknown>>();
  let oracleCalls = 0;
  let oracleCached = 0;
  const oracleMs: number[] = [];
  let oracle: BoundaryOracle | undefined;
  if (cfgDir.boundaryOracle && !has('--no-oracle')) {
    const model = arg('--oracle-model', ORACLE_MODEL);
    const real = createBoundaryOracle(process.env.ANTHROPIC_API_KEY!, cfgDir.sourceLabel, { model, timeoutMs: 2500 });
    const cachePath = path.join(path.dirname(path.dirname(path.dirname(srcDir))), '.oracle-cache.jsonl');
    const cache = new Map<string, { v: OracleVerdict | null; ms: number }>();
    if (fs.existsSync(cachePath)) {
      for (const l of fs.readFileSync(cachePath, 'utf8').split('\n').filter(Boolean)) {
        const e = JSON.parse(l);
        cache.set(e.k, { v: e.v, ms: e.ms });
      }
    }
    const promptHash = crypto.createHash('sha1').update(oraclePrompt(cfgDir.sourceLabel)).digest('hex').slice(0, 8);
    oracle = async (buffer, ctx) => {
      oracleCalls++;
      const pauseBucket = ctx.pauseMs === undefined ? '' : (ctx.pauseMs / 1000).toFixed(1);
      const k = crypto.createHash('sha1').update([model, promptHash, ctx.previous, buffer, pauseBucket].join('\u0000')).digest('hex');
      let hit = cache.get(k);
      if (hit) oracleCached++;
      else {
        const t0 = performance.now();
        const call = real(buffer, ctx);
        pending.add(call);
        const v = await call;
        pending.delete(call);
        hit = { v, ms: Math.round(performance.now() - t0) };
        cache.set(k, hit);
        fs.appendFileSync(cachePath, JSON.stringify({ k, v: hit.v, ms: hit.ms }) + '\n');
      }
      oracleMs.push(hit.ms);
      const latency = hit.ms;
      const verdict = hit.v;
      return new Promise((r) => setTimeout(() => r(verdict), latency));
    };
  }

  // ── 1. Chunk under a simulated clock (run time, in ms) ────────────────────
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const cut: { seq: number; text: string; at: number }[] = [];
  const reasons = new Map<number, string>();
  let seq = 0;
  const chunker = new KoreanChunker({
    mode,
    direction,
    tuning,
    oracle,
    onCut: (s, reason) => reasons.set(s, reason),
    nextSeq: () => ++seq,
    onChunk: async (text, s) => {
      cut.push({ seq: s, text, at: Date.now() / 1000 });
      await new Promise((r) => setTimeout(r, liveLatency));
    },
  });
  let now = 0;
  const flush = async () => {
    await new Promise((r) => setImmediate(r));
    while (pending.size > 0) {
      await Promise.all([...pending]);
      await new Promise((r) => setImmediate(r));
    }
  };
  for (const f of finals) {
    const at = Math.round(f.t * 1000);
    // Small steps, so a completeness check started between finals is answered
    // at the right simulated moment.
    while (now < at) {
      const step = Math.min(50, at - now);
      mock.timers.tick(step);
      now += step;
      await flush();
    }
    // Silence after the last word: known the moment the final arrives.
    const pauseAfterMs =
      typeof f.audioEndSec === 'number' && typeof f.lastWordEndSec === 'number'
        ? Math.max(0, ((f.audioEndSec as number) - (f.lastWordEndSec as number)) * 1000)
        : undefined;
    await chunker.feed(String(f.korean ?? ''), true, { pauseAfterMs });
    await flush();
  }
  for (let k = 0; k < 600; k++) { mock.timers.tick(100); await flush(); }
  mock.timers.reset();
  cut.sort((a, b) => a.seq - b.seq);

  // ── 2. Translate the new chunks for real, in spoken order ─────────────────
  const cfg = getDirectionConfig(direction);
  const detect = cfg.sourceLang === 'en' ? detectReferenceEn : cfg.sourceLang === 'zh' ? detectReferenceZh : detectReference;
  // --prompt <file>: extra instructions appended to the direction's prompt.
  const addendumFile = arg('--prompt');
  const promptAddendum = addendumFile ? fs.readFileSync(addendumFile, 'utf8').trim() : undefined;
  const translator = new ClaudeTranslator(process.env.ANTHROPIC_API_KEY!, arg('--model') || undefined, direction, 'replay', { churchTerms: [], promptAddendum });
  const pace = !has('--no-pace');
  if (!pace) {
    // Baseline: the prompt as it was before the pacing rule.
    const t = translator as unknown as { systemPrompt: string };
    t.systemPrompt = t.systemPrompt.replace(`\n${PACE_RULE}`, '');
  }
  const speed = parseFloat(arg('--speed', '1')) || 1;
  // Listener playback, as the broadcaster estimates it: clips play back to
  // back from the moment their first byte arrives.
  const clips: { arrive: number; dur: number }[] = [];
  const behindAt = (t: number): number => {
    let end = 0;
    for (const c of clips) if (c.arrive <= t) end = Math.max(end, c.arrive) + c.dur;
    return Math.max(0, end - t);
  };
  const behind: number[] = [];
  const rate = voiceRate(srcDir, msgs);
  const fbDelay = firstByteDelay(msgs);
  let currentRef: ScriptureRef | null = null;
  let refAge = 0;
  let lastEmit = 0;
  const out: Msg[] = finals.map((f) => ({ ...f }));
  for (const c of cut) {
    const detected = detect(c.text);
    if (detected) { currentRef = mergeReference(currentRef, detected); refAge = 0; }
    else if (isChinese(direction) && keepReadingZh(currentRef, foldToSimplified(c.text))) refAge = 0;
    else if (currentRef && ++refAge > 12) currentRef = null;
    let english = '';
    let ms = 1200;
    if (!has('--no-translate')) {
      const t = Date.now();
      const behindSec = behindAt(c.at);
      behind.push(behindSec);
      english = (await translator.translate(c.text, currentRef, 1, c.seq, pace ? { behindSec } : undefined)).sermon_translation;
      ms = Date.now() - t;
      process.stdout.write(`\r[chunk-replay] translated ${c.seq}/${cut.length}`);
    }
    // Emission is in spoken order, as the OrderedEmitter enforces.
    const emitAt = Math.max(c.at + ms / 1000, lastEmit);
    lastEmit = emitAt;
    const clipSec = english ? (english.length * rate) / speed : null;
    if (clipSec !== null) clips.push({ arrive: emitAt + fbDelay, dur: clipSec });
    out.push({ t: +emitAt.toFixed(2), src: 'broadcaster', type: 'translation', seq: c.seq, korean: c.text, sermon: english, cutReason: reasons.get(c.seq), clipSec, dispatchedAt: +c.at.toFixed(2), translateMs: ms });
    if (clipSec !== null) out.push({ t: +(emitAt + fbDelay).toFixed(2), type: 'audio_chunk', seq: c.seq, bytes: 0 });
  }
  out.sort((a, b) => a.t - b.t);

  // ── 3. Write it as a run ──────────────────────────────────────────────────
  const outDir = path.join(path.dirname(srcDir), `${label}~${variant}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'messages.jsonl'), out.map((m) => JSON.stringify(m)).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
    ...summary, direction, label: `${label}~${variant}`, replayOf: label, tuning, mode, prompt: addendumFile || null,
    oracle: oracle ? { calls: oracleCalls, cached: oracleCached, p50Ms: median(oracleMs) } : null,
    pace, speed, behindP50: +median(behind).toFixed(1),
    modelled: { secPerChar: +rate.toFixed(4), firstByteDelay: +fbDelay.toFixed(2), gatingTranslateMs: Math.round(liveLatency) },
  }, null, 2));
  console.log(`\n[chunk-replay] ${cut.length} chunks (source run had ${msgs.filter((m) => m.src === 'broadcaster' && m.type === 'translation').length}) → ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
