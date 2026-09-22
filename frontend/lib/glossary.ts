/**
 * Glossary API client.
 *
 * Terms the pipeline must recognise and render consistently — the church's own
 * name, member names, song titles. Two scopes: church terms are permanent,
 * service terms belong to one broadcast.
 */

import { getBackendHttpUrl } from './backend-config';
import { getToken } from './auth';

export type GlossaryBehavior = 'keep' | 'translate';

export interface GlossaryTerm {
  id: string;
  churchId: string;
  /** null = church scope (permanent). */
  sessionId: string | null;
  sourceTerm: string;
  behavior: GlossaryBehavior;
  targets: Record<string, string>;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface GlossarySnapshot {
  /** 'env' means the server has no database and the list is read-only. */
  source: 'db' | 'env';
  church: GlossaryTerm[];
  service: GlossaryTerm[];
  past: GlossaryTerm[];
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

export function fetchGlossary(church: string): Promise<GlossarySnapshot> {
  return request<GlossarySnapshot>(`/glossary?church=${encodeURIComponent(church)}`);
}

export async function addGlossaryTerm(input: {
  church: string;
  sourceTerm: string;
  behavior: GlossaryBehavior;
  targets?: Record<string, string>;
  serviceOnly: boolean;
  notes?: string;
}): Promise<GlossaryTerm> {
  const { term } = await request<{ term: GlossaryTerm }>('/glossary', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return term;
}

export async function updateGlossaryTerm(
  id: string,
  patch: Partial<Pick<GlossaryTerm, 'sourceTerm' | 'behavior' | 'targets' | 'notes'>>,
): Promise<GlossaryTerm> {
  const { term } = await request<{ term: GlossaryTerm }>(`/glossary/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return term;
}

export function deleteGlossaryTerm(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/glossary/${id}`, { method: 'DELETE' });
}

export async function promoteGlossaryTerm(id: string): Promise<GlossaryTerm> {
  const { term } = await request<{ term: GlossaryTerm }>(`/glossary/${id}/promote`, { method: 'POST' });
  return term;
}

/**
 * The desk's one-line entry format. "목장=Mokjang" forces a rendering;
 * a bare "한마음" marks a name to carry across untranslated. Typing one field
 * beats tabbing between three while a service is running.
 */
export function parseTermEntry(raw: string): { sourceTerm: string; behavior: GlossaryBehavior; targets: Record<string, string> } | null {
  const text = raw.trim();
  if (!text) return null;
  const idx = text.indexOf('=');
  if (idx <= 0) return { sourceTerm: text, behavior: 'keep', targets: {} };
  const sourceTerm = text.slice(0, idx).trim();
  const target = text.slice(idx + 1).trim();
  if (!sourceTerm) return null;
  if (!target) return { sourceTerm, behavior: 'keep', targets: {} };
  return { sourceTerm, behavior: 'translate', targets: { en: target } };
}

/** How a term reads in a list: "목장 → Mokjang" or "한마음 · kept as-is". */
export function describeTerm(term: GlossaryTerm): string {
  if (term.behavior === 'keep') return 'kept as-is';
  const target = Object.values(term.targets)[0];
  return target ? `→ ${target}` : '—';
}
