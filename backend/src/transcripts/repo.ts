/**
 * Transcript persistence. Callers check isDbConfigured() / catch: a database
 * problem must cost the transcript, never the service.
 */

import { query } from '../db';
import {
  SegmentTranslation,
  Transcript,
  TranscriptSegment,
  TranscriptSummary,
} from './types';

interface TRow {
  id: string;
  church_id: string;
  session_id: string;
  started_at: Date | string;
  ended_at: Date | string | null;
  source_lang: string;
  target_langs: string[] | null;
  status: string;
}

interface SRow {
  id: string;
  transcript_id: string;
  seq: number;
  offset_ms: number;
  source_text: string;
  translations: Record<string, SegmentTranslation> | null;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : String(v);

function toTranscript(r: TRow): Transcript {
  return {
    id: r.id,
    churchId: r.church_id,
    sessionId: r.session_id,
    startedAt: iso(r.started_at) as string,
    endedAt: iso(r.ended_at),
    sourceLang: r.source_lang,
    targetLangs: r.target_langs ?? [],
    status: r.status === 'complete' ? 'complete' : 'live',
  };
}

function toSegment(r: SRow): TranscriptSegment {
  return {
    id: r.id,
    transcriptId: r.transcript_id,
    seq: r.seq,
    offsetMs: r.offset_ms,
    sourceText: r.source_text,
    translations: r.translations ?? {},
  };
}

const T_COLS = 'id, church_id, session_id, started_at, ended_at, source_lang, target_langs, status';

/**
 * Find or create the transcript for a broadcast. Idempotent on session_id, so
 * a mid-service reconnect resumes the SAME transcript rather than starting a
 * second one — which matches how a resume keeps the same broadcast id.
 */
export async function openTranscript(input: {
  churchId: string;
  sessionId: string;
  sourceLang: string;
  targetLangs: string[];
}): Promise<Transcript> {
  const rows = await query<TRow>(
    `INSERT INTO transcripts (church_id, session_id, source_lang, target_langs)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id) DO UPDATE SET status = 'live', ended_at = NULL
     RETURNING ${T_COLS}`,
    [input.churchId, input.sessionId, input.sourceLang, input.targetLangs],
  );
  return toTranscript(rows[0]);
}

/**
 * Append a batch. ON CONFLICT DO NOTHING makes a retry after a partial failure
 * safe: re-sending a segment that already landed is a no-op rather than a
 * duplicate line in the middle of a sermon.
 */
export async function insertSegments(
  transcriptId: string,
  segments: { seq: number; offsetMs: number; sourceText: string; translations: Record<string, SegmentTranslation> }[],
): Promise<void> {
  if (segments.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [transcriptId];
  for (const s of segments) {
    const base = params.length;
    values.push(`($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`);
    params.push(s.seq, s.offsetMs, s.sourceText, JSON.stringify(s.translations));
  }
  await query(
    `INSERT INTO transcript_segments (transcript_id, seq, offset_ms, source_text, translations)
     VALUES ${values.join(', ')}
     ON CONFLICT (transcript_id, seq) DO NOTHING`,
    params,
  );
}

export async function completeTranscript(transcriptId: string): Promise<void> {
  await query(`UPDATE transcripts SET status = 'complete', ended_at = now() WHERE id = $1`, [
    transcriptId,
  ]);
}

/**
 * The list view. Counts and duration are computed in SQL precisely so the list
 * never loads segments — a church with a year of sermons would otherwise pull
 * every line of every service to render a page of dates.
 */
export async function listTranscripts(
  churchId: string,
  limit = 50,
  offset = 0,
): Promise<TranscriptSummary[]> {
  const rows = await query<TRow & { segment_count: string; duration_sec: string | null }>(
    `SELECT t.id, t.church_id, t.session_id, t.started_at, t.ended_at,
            t.source_lang, t.target_langs, t.status,
            COUNT(s.id)::int AS segment_count,
            (MAX(s.offset_ms) / 1000.0) AS duration_sec
       FROM transcripts t
       LEFT JOIN transcript_segments s ON s.transcript_id = t.id
      WHERE t.church_id = $1
      GROUP BY t.id
      ORDER BY t.started_at DESC
      LIMIT $2 OFFSET $3`,
    [churchId, limit, offset],
  );
  return rows.map((r) => ({
    ...toTranscript(r),
    segmentCount: Number(r.segment_count),
    durationSec: r.duration_sec === null ? null : Math.round(Number(r.duration_sec)),
  }));
}

export async function getTranscript(id: string): Promise<Transcript | null> {
  const rows = await query<TRow>(`SELECT ${T_COLS} FROM transcripts WHERE id = $1`, [id]);
  return rows[0] ? toTranscript(rows[0]) : null;
}

export async function getSegments(transcriptId: string): Promise<TranscriptSegment[]> {
  const rows = await query<SRow>(
    `SELECT id, transcript_id, seq, offset_ms, source_text, translations
       FROM transcript_segments WHERE transcript_id = $1 ORDER BY seq`,
    [transcriptId],
  );
  return rows.map(toSegment);
}

/** Hard delete — a church must be able to remove a sensitive record for real. */
export async function deleteTranscript(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>('DELETE FROM transcripts WHERE id = $1 RETURNING id', [id]);
  return rows.length > 0;
}
