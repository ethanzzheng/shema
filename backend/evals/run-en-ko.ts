/**
 * Tier B — scored English→Korean translation evals.
 *
 * The operator can ear-check English output but not Korean, so this harness
 * is what makes en-ko trustworthy: repeatable, deterministic checks for the
 * things that would be jarring in a Korean church (casual register, missing
 * honorifics for God, untranslated English, English book names), plus an
 * optional LLM judge and an EN→KO→EN round-trip similarity smoke signal.
 *
 * Usage:
 *   npm run eval:en-ko            # deterministic checks (needs ANTHROPIC_API_KEY)
 *   npm run eval:en-ko -- --judge # + LLM-graded faithfulness/naturalness/register
 *
 * Caveat: these checks catch register, script, and gross errors — they do NOT
 * replace a native speaker for nuance. Before a real en-ko service, have a
 * Korean-speaking pastor review one full sermon's output; use this harness
 * for regressions, the human for sign-off.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeTranslator, looksLikeMetaCommentary } from '../src/translation';
import { BOOK_MAP, ScriptureRef } from '../src/scripture';
import { similarity } from './shared';

interface Fixture {
  id: string;
  english: string;
  notes?: string;
  /** Prior segments to seed as context ({source: English, target: Korean}). */
  context?: { source: string; target: string }[];
  expectEmpty?: boolean;
  forbidden?: string[];
  mustContainAny?: string[];
  /** Case-insensitive regexes that must NOT match the output. */
  forbiddenRegex?: string[];
  /** Case-insensitive regexes that MUST all match the output. */
  mustMatchRegex?: string[];
  /** God/Jesus/the Lord/the Spirit acts → expect 께서 or honorific -시- forms. */
  expectHonorificSubject?: boolean;
  /** Scripture quotes may use archaic 개역개정 endings (…느니라) — skip register. */
  registerExempt?: boolean;
  /** Extra English words allowed by the script check (proper nouns etc.). */
  allowEnglish?: string[];
  /** Reference to anchor the translation (mirrors the live pipeline). */
  scripture?: { book: string; chapter?: number; verse?: number };
}

interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

interface FixtureResult {
  id: string;
  english: string;
  output: string;
  checks: CheckResult[];
  pass: boolean;
  /** EN→KO→EN round trip: smoke signal for meaning loss, never a gate. */
  roundTrip?: { backTranslation: string; similarity: number };
  judge?: { faithfulness: number; naturalness: number; register: number; rationale: string };
}

const CONCURRENCY = 4;

// Round-trip similarity below this is worth a human look (reported, not failed).
const ROUND_TRIP_SOFT_FLOOR = 0.3;

// ── Korean-specific checks ─────────────────────────────────────────────────

// Sentence endings acceptable in the 하십시오체 sermon register: -습니다/-ㅂ니다
// (니다), -습니까 (니까), -하십시오, -소서 (prayer), -합시다/-십시다 (시다).
const FORMAL_ENDINGS = ['니다', '니까', '십시오', '소서', '시다'];

// Standalone interjections that legitimately break the ending pattern.
const INTERJECTIONS = ['아멘', '할렐루야', '샬롬'];

/**
 * Sentences (terminated by . ? !) that do NOT end in a 하십시오체 form.
 * Quoted spans are stripped first (quoted dialogue may be casual by design);
 * an unterminated trailing fragment is skipped (mid-sentence cuts are legal).
 */
export function registerViolations(text: string): string[] {
  const cleaned = text.replace(/(["“”‘’'])[^"“”‘’']*(["“”‘’'])/g, ' ');
  const violations: string[] = [];
  for (const m of cleaned.match(/[^.?!]+[.?!]/g) ?? []) {
    const sentence = m.trim();
    const core = sentence.replace(/[.?!…]+$/, '').replace(/[)\]"'”’]+$/, '').trim();
    if (!core) continue;
    if (INTERJECTIONS.some((i) => core === i)) continue;
    if (FORMAL_ENDINGS.some((e) => core.endsWith(e))) continue;
    violations.push(sentence);
  }
  return violations;
}

/**
 * Honorific proxy: the output honors a divine subject via 께서 or an
 * honorific -시- verb form. 하나님은 …사랑하십니다 is correct honorific Korean
 * without 께서, so either signal passes; neither present = failure.
 */
export function hasDivineHonorific(text: string): boolean {
  if (/(하나님|예수님|주님|성령님?)\s*께서/.test(text)) return true;
  return /(십니다|십니까|하시|되시|이시|계시|주시|셨|시며|시고|시는|시니|시기)/.test(text);
}

// Global allowlist for the script check; extend per-fixture (allowEnglish)
// or via EN_KO_EVAL_ALLOWLIST=word,word.
const GLOBAL_ALLOW_ENGLISH = ['qt', 'amen'];

/** Stray Latin-alphabet words not covered by the allowlist. */
export function strayEnglishWords(text: string, allow: string[] = []): string[] {
  const allowSet = new Set(
    [...GLOBAL_ALLOW_ENGLISH, ...allow, ...(process.env.EN_KO_EVAL_ALLOWLIST ?? '').split(',')]
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean),
  );
  const words = text.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  return words.filter((w) => !allowSet.has(w.toLowerCase()));
}

/** Hangul share of the output's letters (Latin + Hangul). 1.0 when no Latin. */
export function hangulRatio(text: string): number {
  const hangul = (text.match(/[가-힣]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (hangul + latin === 0) return 0;
  return hangul / (hangul + latin);
}

// English book names must never survive into Korean output ("John 3:16").
const ENGLISH_BOOK_NAMES = [...new Set(Object.values(BOOK_MAP))];

export function englishBookNamesIn(text: string): string[] {
  return ENGLISH_BOOK_NAMES.filter((b) => new RegExp(`\\b${b}\\b`, 'i').test(text));
}

// ── Check runner ───────────────────────────────────────────────────────────

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

  checks.push({ name: 'no-dashes', pass: !/[—–]/.test(text) && !/-\s*$/.test(text) });
  checks.push({ name: 'no-meta-commentary', pass: !looksLikeMetaCommentary(text) });

  // Register: every finished sentence ends in a 하십시오체 form.
  if (!fx.registerExempt) {
    const bad = registerViolations(text);
    checks.push({
      name: 'register-formal',
      pass: bad.length === 0,
      detail: bad.length ? `casual/plain ending: ${bad.join(' | ')}` : undefined,
    });
  }

  if (fx.expectHonorificSubject) {
    checks.push({
      name: 'honorific-subject',
      pass: hasDivineHonorific(text),
      detail: hasDivineHonorific(text) ? undefined : `no 께서/-시- honorific in: ${text}`,
    });
  }

  // Script: output is Korean, not half-translated English.
  const stray = strayEnglishWords(text, fx.allowEnglish);
  const ratio = hangulRatio(text);
  checks.push({
    name: 'hangul-script',
    pass: stray.length === 0 && ratio >= 0.8,
    detail:
      stray.length || ratio < 0.8
        ? `hangul ratio ${ratio.toFixed(2)}${stray.length ? `, stray English: ${stray.join(', ')}` : ''}`
        : undefined,
  });

  const engBooks = englishBookNamesIn(text);
  checks.push({
    name: 'no-english-book-names',
    pass: engBooks.length === 0,
    detail: engBooks.length ? `found: ${engBooks.join(', ')}` : undefined,
  });

  for (const bad of fx.forbidden ?? []) {
    const hit = text.toLowerCase().includes(bad.toLowerCase());
    checks.push({ name: `forbidden:${bad}`, pass: !hit, detail: hit ? `found "${bad}" in: ${text}` : undefined });
  }

  for (const pattern of fx.forbiddenRegex ?? []) {
    const hit = new RegExp(pattern, 'is').test(text);
    checks.push({ name: `forbidden-regex:${pattern}`, pass: !hit, detail: hit ? `matched /${pattern}/ in: ${text}` : undefined });
  }

  for (const pattern of fx.mustMatchRegex ?? []) {
    const hit = new RegExp(pattern, 'is').test(text);
    checks.push({ name: `must-match:${pattern}`, pass: hit, detail: hit ? undefined : `no match for /${pattern}/ in: ${text}` });
  }

  if (fx.mustContainAny && fx.mustContainAny.length > 0) {
    const hit = fx.mustContainAny.some((w) => text.includes(w));
    checks.push({
      name: `contains-any:[${fx.mustContainAny.join('|')}]`,
      pass: hit,
      detail: hit ? undefined : `output: ${text}`,
    });
  }

  return checks;
}

// ── LLM judge (optional) ───────────────────────────────────────────────────

async function judgeOutput(
  client: Anthropic,
  english: string,
  korean: string,
): Promise<{ faithfulness: number; naturalness: number; register: number; rationale: string }> {
  const resp = await client.messages.create({
    // Haiku is cheap but occasionally over-flags legitimate ADDRESSEE
    // honorifics (여러분 …하시기 바랍니다) as register errors — read the
    // rationales critically, or point this at a stronger judge for a tie-break.
    model: process.env.EVAL_JUDGE_MODEL || 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    system:
      'You grade English→Korean translations of live sermon segments for a church interpretation system. ' +
      'Return ONLY JSON: {"faithfulness": 1-5, "naturalness": 1-5, "register": 1-5, "rationale": "one short sentence"}. ' +
      'faithfulness = the English meaning fully preserved, nothing invented or dropped. ' +
      'naturalness = sounds like a Korean pastor actually preaching, not translated-ese. ' +
      'register = consistent formal-polite 하십시오체 with correct honorifics for God/Jesus (하나님께서, 예수님께서, -하십니다); casual endings or missing honorifics lower this. ' +
      'The rationale must name the biggest problem (or say "clean").',
    messages: [{ role: 'user', content: `English: ${english}\nKorean: ${korean}` }],
  });
  const raw = resp.content.find((b) => b.type === 'text');
  const m = (raw && 'text' in raw ? raw.text : '').match(/\{[\s\S]*\}/);
  const parsed = m ? JSON.parse(m[0]) : {};
  return {
    faithfulness: Number(parsed.faithfulness) || 0,
    naturalness: Number(parsed.naturalness) || 0,
    register: Number(parsed.register) || 0,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY required (evals call the real translator).');
    process.exit(1);
  }
  const judge = process.argv.includes('--judge');
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const fixturePath = path.join(__dirname, 'fixtures-en-ko.jsonl');
  const fixtures: Fixture[] = fs
    .readFileSync(fixturePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  console.log(`Running ${fixtures.length} en-ko fixtures (concurrency ${CONCURRENCY})${judge ? ' + judge' : ''}...\n`);
  const judgeClient = judge ? new Anthropic({ apiKey }) : null;

  const results: FixtureResult[] = new Array(fixtures.length);
  let next = 0;
  async function worker() {
    while (next < fixtures.length) {
      const i = next++;
      const fx = fixtures[i];
      // Fresh translators per fixture — no cross-fixture context contamination.
      const translator = new ClaudeTranslator(apiKey!, undefined, 'en-ko');
      if (fx.context) {
        // seedContext's field names are historical: korean = SOURCE, english = TARGET.
        translator.seedContext(fx.context.map((c) => ({ korean: c.source, english: c.target })));
      }
      const ref: ScriptureRef | null = fx.scripture
        ? { book: fx.scripture.book, chapter: fx.scripture.chapter, verse: fx.scripture.verse }
        : null;
      let output = '';
      try {
        output = (await translator.translate(fx.english, ref)).sermon_translation;
      } catch (err) {
        output = `[eval-error: ${(err as Error).message}]`;
      }
      const checks = runChecks(fx, output);
      const result: FixtureResult = {
        id: fx.id,
        english: fx.english,
        output,
        checks,
        pass: checks.every((c) => c.pass),
      };

      const usable = output && output !== '[Translation error]' && !output.startsWith('[eval-error');
      // Round trip EN→KO→EN with the real ko-en translator: a smoke signal
      // for meaning loss (noisy — reported, never gated).
      if (usable && !fx.expectEmpty) {
        try {
          const back = new ClaudeTranslator(apiKey!); // ko-en
          const backOut = (await back.translate(output)).sermon_translation;
          if (backOut && backOut !== '[Translation error]') {
            result.roundTrip = { backTranslation: backOut, similarity: similarity(fx.english, backOut) };
          }
        } catch {
          /* round trip is best-effort */
        }
      }
      if (judgeClient && usable) {
        try {
          result.judge = await judgeOutput(judgeClient, fx.english, output);
        } catch {
          /* judge is best-effort */
        }
      }

      results[i] = result;
      const mark = result.pass ? '✅' : '❌';
      const rt = result.roundTrip ? ` (rt ${result.roundTrip.similarity.toFixed(2)})` : '';
      console.log(`${mark} ${fx.id}${rt}`);
      for (const c of checks.filter((c) => !c.pass)) {
        console.log(`   ↳ FAIL ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
      }
      if (result.judge && (result.judge.faithfulness < 4 || result.judge.register < 4 || result.judge.naturalness < 4)) {
        console.log(`   ↳ judge f${result.judge.faithfulness} n${result.judge.naturalness} r${result.judge.register}: ${result.judge.rationale}`);
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
  console.log('\n── Scorecard (en-ko) ──────────────────');
  for (const [name, { pass, total }] of byCheck) {
    console.log(`${name.padEnd(24)} ${pass}/${total}`);
  }
  console.log('───────────────────────────────────────');
  console.log(`overall: ${passed}/${results.length} fixtures pass`);

  const withRt = results.filter((r) => r.roundTrip);
  if (withRt.length) {
    const avg = withRt.reduce((s, r) => s + r.roundTrip!.similarity, 0) / withRt.length;
    const weak = withRt.filter((r) => r.roundTrip!.similarity < ROUND_TRIP_SOFT_FLOOR);
    console.log(`round-trip similarity: avg ${avg.toFixed(2)} over ${withRt.length} fixtures (smoke signal, not a gate)`);
    for (const r of weak) {
      console.log(`   ⚠ ${r.id} rt ${r.roundTrip!.similarity.toFixed(2)} — back: ${r.roundTrip!.backTranslation}`);
    }
  }
  if (judge) {
    const graded = results.filter((r) => r.judge);
    if (graded.length) {
      const avg = (k: 'faithfulness' | 'naturalness' | 'register') =>
        (graded.reduce((s, r) => s + r.judge![k], 0) / graded.length).toFixed(2);
      console.log(
        `judge: faithfulness ${avg('faithfulness')}/5, naturalness ${avg('naturalness')}/5, register ${avg('register')}/5 (${graded.length} graded)`,
      );
    }
  }

  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `en-ko-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ passed, total: results.length, results }, null, 2));
  console.log(`\nresults written to ${path.relative(process.cwd(), outPath)}`);

  process.exit(passed === results.length ? 0 : 1);
}

// Only run as a script — the checks above are imported by unit tests.
if (require.main === module) {
  main();
}
