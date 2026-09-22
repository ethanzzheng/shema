/**
 * Getting a church's glossary at broadcast start, from the database if it is
 * there and the env vars if it is not.
 *
 * The fallback is not a nicety: a database outage on a Sunday morning must
 * degrade to last week's terms, not to a service that cannot go on air.
 */

import { isDbConfigured } from '../db';
import { listChurchTerms } from './repo';
import { envTerms } from './env';
import { GlossaryTerm, LangCode } from './types';

export interface LoadedGlossary {
  terms: GlossaryTerm[];
  source: 'db' | 'env';
}

export async function loadChurchGlossary(
  churchId: string,
  lang: LangCode = 'en',
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
  return { terms: envTerms(churchId, process.env, lang), source: 'env' };
}
