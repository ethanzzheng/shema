/**
 * Glossary domain types.
 *
 * Two scopes share one table, distinguished by session_id:
 *   church  (session_id NULL) — permanent, recurring: "목장", the church's name
 *   service (session_id set)  — one broadcast: song titles, a visiting speaker
 */

/**
 * 'keep'      — carry the term across untranslated/transliterated as-is.
 * 'translate' — force the rendering held in `targets`.
 */
export type GlossaryBehavior = 'keep' | 'translate';

/** Output-language code, matching the pipeline's directions. */
export type LangCode = 'en' | 'ko';

export interface GlossaryTerm {
  id: string;
  churchId: string;
  /** null = church scope. */
  sessionId: string | null;
  sourceTerm: string;
  behavior: GlossaryBehavior;
  /** Per-language forced renderings, e.g. { en: 'Mokjang' }. Empty for 'keep'. */
  targets: Record<string, string>;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
}

/** Fields an operator supplies when adding a term. */
export interface NewGlossaryTerm {
  churchId: string;
  sessionId?: string | null;
  sourceTerm: string;
  behavior?: GlossaryBehavior;
  targets?: Record<string, string>;
  notes?: string | null;
  createdBy?: string | null;
}

export function isBehavior(v: unknown): v is GlossaryBehavior {
  return v === 'keep' || v === 'translate';
}
