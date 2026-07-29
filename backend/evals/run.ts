/**
 * Tier B — scored translation evals.
 *
 * Runs the REAL translate() against a golden set of Korean segments and scores
 * the output with deterministic assertion checks (plus an optional LLM judge).
 * Prints a scorecard and writes evals/results/<timestamp>.json for diffing runs.
 *
 * Usage:
 *   npm run eval            # assertion checks only (needs ANTHROPIC_API_KEY)
 *   npm run eval -- --judge # + LLM-graded faithfulness/fluency (extra tokens)
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeTranslator, looksLikeMetaCommentary } from '../src/translation';
import { getVerse } from '../src/bible';
import { similarity } from './shared';

interface Fixture {
  id: string;
  korean: string;
  notes?: string;
  /** Prior segments to seed as conversational context (mimics mid-sermon state). */
  context?: { korean: string; english: string }[];
  expectEmpty?: boolean;
  forbidden?: string[];
  mustContainAny?: string[];
  /** Case-insensitive regexes that must NOT match the output. */
  forbiddenRegex?: string[];
  /** Case-insensitive regexes that MUST all match the output. */
  mustMatchRegex?: string[];
  scripture?: { book: string; chapter: number; verse: number; minSim?: number };
}

interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

interface FixtureResult {
  id: string;
  korean: string;
  output: string;
  checks: CheckResult[];
  pass: boolean;
  judge?: { faithfulness: number; fluency: number };
}

const CONCURRENCY = 4;
const DEFAULT_MIN_SIM = 0.55;

function runChecks(fx: Fixture, output: string): CheckResult[] {
  const checks: CheckResult[] = [];
  const empty = !output || output === '[Translation error]';
  const text = empty ? '' : output;

  if (fx.expectEmpty) {
    checks.push({ name: 'empty-when-filler', pass: empty, detail: empty ? undefined : `got: ${text}` });
    return checks; // nothing else applies to an (expected) empty output
  }

  checks.push({ name: 'non-empty', pass: !empty });
  if (empty) return checks;

  checks.push({
    name: 'no-dashes',
    pass: !/[—–]/.test(text) && !/-\s*$/.test(text),
  });
  checks.push({ name: 'no-meta-commentary', pass: !looksLikeMetaCommentary(text) });

  for (const bad of fx.forbidden ?? []) {
    checks.push({
      name: `forbidden:${bad}`,
      pass: !text.toLowerCase().includes(bad.toLowerCase()),
      detail: text.toLowerCase().includes(bad.toLowerCase()) ? `found "${bad}" in: ${text}` : undefined,
    });
  }

  for (const pattern of fx.forbiddenRegex ?? []) {
    const hit = new RegExp(pattern, 'is').test(text);
    checks.push({
      name: `forbidden-regex:${pattern}`,
      pass: !hit,
      detail: hit ? `matched /${pattern}/ in: ${text}` : undefined,
    });
  }

  for (const pattern of fx.mustMatchRegex ?? []) {
    const hit = new RegExp(pattern, 'is').test(text);
    checks.push({
      name: `must-match:${pattern}`,
      pass: hit,
      detail: hit ? undefined : `no match for /${pattern}/ in: ${text}`,
    });
  }

  if (fx.mustContainAny && fx.mustContainAny.length > 0) {
    const hit = fx.mustContainAny.some((w) => text.toLowerCase().includes(w.toLowerCase()));
    checks.push({
      name: `contains-any:[${fx.mustContainAny.join('|')}]`,
      pass: hit,
      detail: hit ? undefined : `output: ${text}`,
    });
  }

  if (fx.scripture) {
    const { book, chapter, verse } = fx.scripture;
    const canonical = getVerse(book, chapter, verse);
    if (!canonical) {
      checks.push({ name: 'scripture-lookup', pass: false, detail: `no canonical text for ${book} ${chapter}:${verse}` });
    } else {
      const sim = similarity(text, canonical);
      const min = fx.scripture.minSim ?? DEFAULT_MIN_SIM;
      checks.push({
        name: `scripture-match(≥${min})`,
        pass: sim >= min,
        detail: `sim=${sim.toFixed(2)} | out: ${text} | canon: ${canonical}`,
      });
    }
  }

  return checks;
}

async function judgeOutput(
  client: Anthropic,
  korean: string,
  english: string,
): Promise<{ faithfulness: number; fluency: number }> {
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 128,
    system:
      'You grade Korean→English sermon translations. Return ONLY JSON: {"faithfulness": 1-5, "fluency": 1-5}. ' +
      'Faithfulness = meaning preserved, nothing invented. Fluency = natural spoken American English.',
    messages: [{ role: 'user', content: `Korean: ${korean}\nEnglish: ${english}` }],
  });
  const raw = resp.content.find((b) => b.type === 'text');
  const m = (raw && 'text' in raw ? raw.text : '').match(/\{[\s\S]*\}/);
  const parsed = m ? JSON.parse(m[0]) : {};
  return {
    faithfulness: Number(parsed.faithfulness) || 0,
    fluency: Number(parsed.fluency) || 0,
  };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY required (evals call the real translator).');
    process.exit(1);
  }
  const judge = process.argv.includes('--judge');

  const fixturePath = path.join(__dirname, 'fixtures.jsonl');
  const fixtures: Fixture[] = fs
    .readFileSync(fixturePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  console.log(`Running ${fixtures.length} fixtures (concurrency ${CONCURRENCY})${judge ? ' + judge' : ''}...\n`);
  const judgeClient = judge ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

  const results: FixtureResult[] = new Array(fixtures.length);
  let next = 0;
  async function worker() {
    while (next < fixtures.length) {
      const i = next++;
      const fx = fixtures[i];
      // Fresh translator per fixture — no cross-fixture context contamination.
      const translator = new ClaudeTranslator(process.env.ANTHROPIC_API_KEY!);
      if (fx.context) translator.seedContext(fx.context);
      const ref = fx.scripture
        ? { book: fx.scripture.book, chapter: fx.scripture.chapter, verse: fx.scripture.verse }
        : null;
      let output = '';
      try {
        output = (await translator.translate(fx.korean, ref)).sermon_translation;
      } catch (err) {
        output = `[eval-error: ${(err as Error).message}]`;
      }
      const checks = runChecks(fx, output);
      const result: FixtureResult = {
        id: fx.id,
        korean: fx.korean,
        output,
        checks,
        pass: checks.every((c) => c.pass),
      };
      if (judgeClient && output && output !== '[Translation error]') {
        try {
          result.judge = await judgeOutput(judgeClient, fx.korean, output);
        } catch {
          /* judge is best-effort */
        }
      }
      results[i] = result;
      const mark = result.pass ? '✅' : '❌';
      console.log(`${mark} ${fx.id}`);
      for (const c of checks.filter((c) => !c.pass)) {
        console.log(`   ↳ FAIL ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // ── Scorecard ──────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.pass).length;
  const byCheck = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    for (const c of r.checks) {
      const key = c.name.replace(/:.*$/, ''); // group forbidden:/contains-any: variants
      const e = byCheck.get(key) ?? { pass: 0, total: 0 };
      e.total++;
      if (c.pass) e.pass++;
      byCheck.set(key, e);
    }
  }
  console.log('\n── Scorecard ──────────────────────────');
  for (const [name, { pass, total }] of byCheck) {
    console.log(`${name.padEnd(24)} ${pass}/${total}`);
  }
  console.log('───────────────────────────────────────');
  console.log(`overall: ${passed}/${results.length} fixtures pass`);
  if (judge) {
    const graded = results.filter((r) => r.judge);
    if (graded.length) {
      const avg = (k: 'faithfulness' | 'fluency') =>
        (graded.reduce((s, r) => s + r.judge![k], 0) / graded.length).toFixed(2);
      console.log(`judge: faithfulness ${avg('faithfulness')}/5, fluency ${avg('fluency')}/5 (${graded.length} graded)`);
    }
  }

  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ passed, total: results.length, results }, null, 2));
  console.log(`\nresults written to ${path.relative(process.cwd(), outPath)}`);

  process.exit(passed === results.length ? 0 : 1);
}

main();
