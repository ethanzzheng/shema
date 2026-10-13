/**
 * Getting a church's glossary at broadcast start, from the database if it is
 * there and the env vars if it is not.
 *
 * The fallback is not a nicety: a database outage on a Sunday morning must
 * degrade to last week's terms, not to a service that cannot go on air.
 */

import { isDbConfigured } from '../db';
import { listChurchTerms, listSessionTerms } from './repo';
import { envTerms } from './env';
import { GlossaryTerm, LangCode } from './types';

export interface LoadedGlossary {
  terms: GlossaryTerm[];
  source: 'db' | 'env';
}

/**
 * Does a term's source text belong to the language the pastor speaks? The env
 * fallback is one flat list per deployment, written for the Korean churches;
 * without this check a Mandarin room was handed 목장 = "Mokjang".
 */
export function matchesSourceLanguage(term: GlossaryTerm, sourceLang: string): boolean {
  const t = term.sourceTerm;
  const hangul = /[\uac00-\ud7af]/.test(t);
  const han = /[\u4e00-\u9fff]/.test(t);
  if (sourceLang === 'ko') return hangul || !han;
  if (sourceLang === 'zh') return han && !hangul;
  if (sourceLang === 'en') return !hangul && !han;
  return true;
}

export async function loadChurchGlossary(
  churchId: string,
  lang: LangCode = 'en',
  sourceLang?: string,
): Promise<LoadedGlossary> {
  if (isDbConfigured()) {
    try {
      return { terms: await listChurchTerms(churchId), source: 'db' };
    } catch (err) {
      console.warn(
        `[Glossary] Database unreachable for "${churchId}" (${(err as Error).message}) — ` +
          'falling back to CHURCH_GLOSSARY env vars for this broadcast.',
      );
    }
  }
  const terms = envTerms(churchId, process.env, lang);
  return { terms: sourceLang ? terms.filter((t) => matchesSourceLanguage(t, sourceLang)) : terms, source: 'env' };
}

/**
 * Service-scope terms for one broadcast. Returns [] rather than throwing: a
 * database problem must degrade the glossary, never stop a service going live.
 */
export async function loadSessionTerms(broadcastId: string): Promise<GlossaryTerm[]> {
  if (!isDbConfigured()) return [];
  try {
    return await listSessionTerms(broadcastId);
  } catch (err) {
    console.warn(`[Glossary] Could not load service terms: ${(err as Error).message}`);
    return [];
  }
}
