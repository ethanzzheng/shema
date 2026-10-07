/**
 * Transcript API client.
 *
 * A transcript is one service's bilingual record: what the pastor said and
 * what Shema rendered it as. Text only.
 */

import { getBackendHttpUrl } from './backend-config';
import { getToken } from './auth';

/** Shema produces two renderings of one language, not several languages. */
export interface SegmentTranslation {
  /** The natural preached form, which is what the congregation heard. */
  sermon: string;
  /** The literal translation. */
  direct: string;
}

export interface TranscriptSegment {
  id: string;
  seq: number;
  offsetMs: number;
  sourceText: string;
  translations: Record<string, SegmentTranslation>;
}

export interface TranscriptSummary {
  id: string;
  churchId: string;
  startedAt: string;
  endedAt: string | null;
  sourceLang: string;
  targetLangs: string[];
  status: 'live' | 'complete';
  segmentCount: number;
  durationSec: number | null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${getBackendHttpUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export async function fetchTranscripts(church: string): Promise<TranscriptSummary[]> {
  const { transcripts } = await request<{ transcripts: TranscriptSummary[] }>(
    `/transcripts?church=${encodeURIComponent(church)}`,
  );
  return transcripts;
}

export function fetchTranscript(
  id: string,
): Promise<{ transcript: TranscriptSummary; segments: TranscriptSegment[] }> {
  return request(`/transcripts/${id}`);
}

export function deleteTranscript(id: string): Promise<{ ok: true }> {
  return request(`/transcripts/${id}`, { method: 'DELETE' });
}

/** "Sunday, 5 October" — the way a church refers to a service. */
export function serviceDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

export function serviceYear(iso: string): string {
  return String(new Date(iso).getFullYear());
}

/** Whole minutes; services run to the hour, so seconds are noise. */
export function durationLabel(sec: number | null): string {
  if (!sec) return '—';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Position within the service, as a listener would scrub to it. */
export function offsetLabel(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export type ExportMode = 'bilingual' | 'translation' | 'original';

/** Plain text for copy and .txt download. */
export function buildExport(
  t: TranscriptSummary,
  segments: TranscriptSegment[],
  mode: ExportMode,
  lang: string,
): string {
  const head = [`${serviceDate(t.startedAt)} ${serviceYear(t.startedAt)}`, durationLabel(t.durationSec), ''];
  const body = segments.map((s) => {
    const tr = s.translations[lang];
    const target = tr?.sermon ?? '';
    if (mode === 'original') return s.sourceText;
    if (mode === 'translation') return target;
    return `${s.sourceText}\n${target}`;
  });
  return [...head, body.join(mode === 'bilingual' ? '\n\n' : '\n')].join('\n');
}
