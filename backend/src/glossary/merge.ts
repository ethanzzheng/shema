/**
 * Turning glossary terms into the two things the pipeline actually consumes:
 * prompt lines for the translator, and keyterms for Deepgram.
 *
 * Pure functions over in-memory arrays — no I/O. The live pipeline calls these
 * per chunk, so they must stay cheap.
 */

import { GlossaryTerm, LangCode } from './types';

/**
 * Deepgram nova-3 keyterm prompting: at most 100 terms and 500 tokens per
 * request, and the terms are baked into the connection URL — they cannot be
 * changed on an open socket (mid-stream updates are a Flux-only feature).
 * https://developers.deepgram.com/docs/keyterm
 */
export const MAX_KEYTERMS = 100;
export const MAX_KEYTERM_TOKENS = 500;

/**
 * Above this many live terms we stop sending the whole list every call and
 * send only what the chunk actually mentions. Below it, sending everything is
 * cheaper than being clever.
 */
export const LIVE_TERM_FILTER_THRESHOLD = 100;

/**
 * Deliberately generous: over-estimating costs us a few dropped keyterms,
 * under-estimating gets the whole request rejected by Deepgram. Korean packs
 * roughly two characters per token; Latin script runs longer per token.
 */
export function estimateTokens(term: string): number {
  const chars = [...term].length;
  const cjk = (term.match(/[ㄱ-힝一-鿿]/g) ?? []).length;
  return Math.max(1, cjk > 0 ? Math.ceil(chars / 2) : Math.ceil(chars / 3));
}

/** Church terms first, then service terms, preserving each group's order. */
export function orderTerms(terms: GlossaryTerm[]): GlossaryTerm[] {
  return [
    ...terms.filter((t) => t.sessionId === null),
    ...terms.filter((t) => t.sessionId !== null),
  ];
}

/**
 * The rendering to force for a term in the given output language. Falls back to
 * any target that exists: the seeded env glossary only ever carried English,
 * and a Korean-output broadcast should still pin the name rather than ignore it.
 */
export function targetFor(term: GlossaryTerm, lang: LangCode): string | null {
  return term.targets[lang] ?? Object.values(term.targets)[0] ?? null;
}

/**
 * Prompt lines. Format follows what the system prompt already used for the env
 * glossary (`목장 = "Mokjang"`) so the model sees nothing new in shape.
 */
export function renderGlossaryLines(terms: GlossaryTerm[], lang: LangCode): string {
  // Church terms are inserted first and service terms overwrite them, so a
  // term added for today's service beats the permanent one. Same precedence
  // the env vars already had, where CHURCH_GLOSSARY_<SLUG> overrode
  // CHURCH_GLOSSARY: the more specific, more deliberate entry wins.
  const byTerm = new Map<string, GlossaryTerm>();
  for (const term of orderTerms(terms)) byTerm.set(term.sourceTerm, term);

  const lines: string[] = [];
  for (const term of byTerm.values()) {
    if (term.behavior === 'keep') {
      lines.push(`${term.sourceTerm} = keep as "${term.sourceTerm}" (a name — do not translate it)`);
      continue;
    }
    const target = targetFor(term, lang);
    if (target) lines.push(`${term.sourceTerm} = "${target}"`);
  }
  return lines.join('\n');
}

/**
 * Terms the chunk actually mentions. Substring is the right test for Korean,
 * which has no word boundaries; Latin script is compared case-insensitively.
 */
export function termsInText(terms: GlossaryTerm[], text: string): GlossaryTerm[] {
  const lower = text.toLowerCase();
  return terms.filter((t) =>
    /[ㄱ-힝一-鿿]/.test(t.sourceTerm)
      ? text.includes(t.sourceTerm)
      : lower.includes(t.sourceTerm.toLowerCase()),
  );
}

/** Full list when it is small; only what the chunk mentions when it is not. */
export function liveTermsForChunk(terms: GlossaryTerm[], text: string): GlossaryTerm[] {
  return terms.length <= LIVE_TERM_FILTER_THRESHOLD ? terms : termsInText(terms, text);
}

export interface KeytermBudget {
  keyterms: string[];
  dropped: string[];
}

/**
 * Glossary source terms take precedence over the generic defaults: they are the
 * ones a human went out of their way to say were being got wrong. Truncation is
 * reported rather than silent — a quietly dropped keyterm looks identical to a
 * glossary that simply does not work.
 */
export function budgetKeyterms(glossaryTerms: string[], defaults: string[]): KeytermBudget {
  const keyterms: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  let tokens = 0;

  for (const raw of [...glossaryTerms, ...defaults]) {
    const term = raw.trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    const cost = estimateTokens(term);
    if (keyterms.length >= MAX_KEYTERMS || tokens + cost > MAX_KEYTERM_TOKENS) {
      dropped.push(term);
      continue;
    }
    keyterms.push(term);
    tokens += cost;
  }
  return { keyterms, dropped };
}
