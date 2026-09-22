/**
 * The CHURCH_GLOSSARY env vars, kept as a read-only fallback.
 *
 * They were the whole glossary before Postgres, and they remain the safety net:
 * if the database is unreachable when a broadcast starts, the service still
 * goes on air with the terms it had. Nothing writes here any more.
 */

import { GlossaryTerm, LangCode } from './types';

/** "grace-church" → CHURCH_GLOSSARY_GRACE_CHURCH. Slugs are already [a-z0-9-]. */
export function glossaryEnvKey(roomId: string): string {
  return `CHURCH_GLOSSARY_${roomId.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * "목장=Mokjang,목자=shepherd" → Map.
 *
 * Splits on the FIRST '=' only, so a rendering may itself contain '='. A value
 * containing a comma still cannot be expressed — the format has no escaping —
 * which is one of the reasons terms now live in the database instead.
 */
export function parseGlossaryPairs(raw: string | undefined, into: Map<string, string>): void {
  if (!raw) return;
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const source = pair.slice(0, idx).trim();
    const target = pair.slice(idx + 1).trim();
    if (source && target) into.set(source, target);
  }
}

/** Global CHURCH_GLOSSARY, then the per-church var, which overrides it. */
export function envGlossaryPairs(
  env: NodeJS.ProcessEnv = process.env,
  roomId?: string,
): Map<string, string> {
  const merged = new Map<string, string>();
  parseGlossaryPairs(env.CHURCH_GLOSSARY, merged);
  if (roomId) parseGlossaryPairs(env[glossaryEnvKey(roomId)], merged);
  return merged;
}

/**
 * Env pairs as church-scope terms, so the fallback path feeds exactly the same
 * code as the database path. Ids are synthetic — these rows do not exist.
 */
export function envTerms(
  churchId: string,
  env: NodeJS.ProcessEnv = process.env,
  lang: LangCode = 'en',
): GlossaryTerm[] {
  return [...envGlossaryPairs(env, churchId)].map(([sourceTerm, target], i) => ({
    id: `env:${i}`,
    churchId,
    sessionId: null,
    sourceTerm,
    behavior: 'translate' as const,
    targets: { [lang]: target },
    notes: null,
    createdAt: new Date(0).toISOString(),
    createdBy: 'env',
  }));
}
