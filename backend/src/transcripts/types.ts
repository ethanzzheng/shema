/**
 * Transcript domain types.
 *
 * A transcript is one broadcast's bilingual record: the source text the pastor
 * actually said, and what Shema rendered it as. Text only — no audio is stored.
 */

export type TranscriptStatus = 'live' | 'complete';

/**
 * The two renderings Shema produces for one output language. `sermon` is the
 * natural preached form that is spoken aloud; `direct` is the literal
 * translation. Keyed by language so genuine multi-language needs no migration.
 */
export interface SegmentTranslation {
  sermon: string;
  direct: string;
}

export interface TranscriptSegment {
  id: string;
  transcriptId: string;
  seq: number;
  /** Milliseconds from the transcript's start. */
  offsetMs: number;
  sourceText: string;
  translations: Record<string, SegmentTranslation>;
}

export interface Transcript {
  id: string;
  churchId: string;
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  sourceLang: string;
  targetLangs: string[];
  status: TranscriptStatus;
}

/** A row in the list view. Deliberately carries no segments — see repo.list. */
export interface TranscriptSummary extends Transcript {
  segmentCount: number;
  /** Seconds between the first and last segment, or null while empty. */
  durationSec: number | null;
}
