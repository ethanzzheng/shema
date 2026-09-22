/**
 * Glossary persistence. Every function assumes a configured database; callers
 * check isDbConfigured() / catch and fall back to the env glossary.
 */

import { query } from '../db';
import { GlossaryTerm, NewGlossaryTerm } from './types';

interface Row {
  id: string;
  church_id: string;
  session_id: string | null;
  source_term: string;
  behavior: string;
  targets: Record<string, string> | null;
  notes: string | null;
  created_at: Date | string;
  created_by: string | null;
}

function toTerm(r: Row): GlossaryTerm {
  return {
    id: r.id,
    churchId: r.church_id,
    sessionId: r.session_id,
    sourceTerm: r.source_term,
    behavior: r.behavior === 'keep' ? 'keep' : 'translate',
    targets: r.targets ?? {},
    notes: r.notes,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    createdBy: r.created_by,
  };
}

const COLS = 'id, church_id, session_id, source_term, behavior, targets, notes, created_at, created_by';

/** Church-scope terms only (the permanent glossary). */
export async function listChurchTerms(churchId: string): Promise<GlossaryTerm[]> {
  const rows = await query<Row>(
    `SELECT ${COLS} FROM glossary_terms
      WHERE church_id = $1 AND session_id IS NULL
      ORDER BY created_at`,
    [churchId],
  );
  return rows.map(toTerm);
}

/** Terms belonging to one broadcast. */
export async function listSessionTerms(sessionId: string): Promise<GlossaryTerm[]> {
  const rows = await query<Row>(
    `SELECT ${COLS} FROM glossary_terms WHERE session_id = $1 ORDER BY created_at`,
    [sessionId],
  );
  return rows.map(toTerm);
}

/**
 * Past service-scope terms, newest first — what the management page offers to
 * promote into the permanent glossary.
 */
export async function listRecentSessionTerms(churchId: string, limit = 200): Promise<GlossaryTerm[]> {
  const rows = await query<Row>(
    `SELECT ${COLS} FROM glossary_terms
      WHERE church_id = $1 AND session_id IS NOT NULL
      ORDER BY created_at DESC LIMIT $2`,
    [churchId, limit],
  );
  return rows.map(toTerm);
}

export async function getTerm(id: string): Promise<GlossaryTerm | null> {
  const rows = await query<Row>(`SELECT ${COLS} FROM glossary_terms WHERE id = $1`, [id]);
  return rows[0] ? toTerm(rows[0]) : null;
}

/**
 * Returns null when a church-scope term with this source already exists — the
 * partial unique index makes that a no-op rather than an error, so adding a
 * duplicate is harmless for an operator in a hurry.
 */
export async function addTerm(input: NewGlossaryTerm): Promise<GlossaryTerm | null> {
  const rows = await query<Row>(
    `INSERT INTO glossary_terms (church_id, session_id, source_term, behavior, targets, notes, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT DO NOTHING
     RETURNING ${COLS}`,
    [
      input.churchId,
      input.sessionId ?? null,
      input.sourceTerm.trim(),
      input.behavior ?? 'translate',
      JSON.stringify(input.targets ?? {}),
      input.notes ?? null,
      input.createdBy ?? null,
    ],
  );
  return rows[0] ? toTerm(rows[0]) : null;
}

export async function updateTerm(
  id: string,
  patch: Partial<Pick<GlossaryTerm, 'sourceTerm' | 'behavior' | 'targets' | 'notes'>>,
): Promise<GlossaryTerm | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (frag: string, value: unknown) => {
    params.push(value);
    sets.push(`${frag} = $${params.length}`);
  };
  if (patch.sourceTerm !== undefined) push('source_term', patch.sourceTerm.trim());
  if (patch.behavior !== undefined) push('behavior', patch.behavior);
  if (patch.targets !== undefined) {
    params.push(JSON.stringify(patch.targets));
    sets.push(`targets = $${params.length}::jsonb`);
  }
  if (patch.notes !== undefined) push('notes', patch.notes);
  if (sets.length === 0) return getTerm(id);

  params.push(id);
  const rows = await query<Row>(
    `UPDATE glossary_terms SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${COLS}`,
    params,
  );
  return rows[0] ? toTerm(rows[0]) : null;
}

export async function deleteTerm(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>('DELETE FROM glossary_terms WHERE id = $1 RETURNING id', [id]);
  return rows.length > 0;
}

/**
 * Promote a service term to church scope by clearing its session. If the church
 * already has that term the promotion is redundant, so the row is removed
 * instead of colliding with the unique index.
 */
export async function promoteTerm(id: string): Promise<GlossaryTerm | null> {
  const existing = await getTerm(id);
  if (!existing) return null;
  if (existing.sessionId === null) return existing;

  const rows = await query<Row>(
    `UPDATE glossary_terms SET session_id = NULL WHERE id = $1
       AND NOT EXISTS (
         SELECT 1 FROM glossary_terms g
          WHERE g.church_id = $2 AND g.source_term = $3 AND g.session_id IS NULL
       )
     RETURNING ${COLS}`,
    [id, existing.churchId, existing.sourceTerm],
  );
  if (rows[0]) return toTerm(rows[0]);

  await deleteTerm(id);
  const rowsExisting = await query<Row>(
    `SELECT ${COLS} FROM glossary_terms
      WHERE church_id = $1 AND source_term = $2 AND session_id IS NULL`,
    [existing.churchId, existing.sourceTerm],
  );
  return rowsExisting[0] ? toTerm(rowsExisting[0]) : null;
}
