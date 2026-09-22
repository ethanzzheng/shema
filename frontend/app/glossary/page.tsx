'use client';

/**
 * Glossary management — the permanent, church-scope terms, plus the one-off
 * terms past services left behind.
 *
 * The broadcast desk's Terms card is for the heat of a service; this is where
 * the glossary gets tidied afterwards: correct a rendering, drop something
 * that was a mistake, or promote a song title that turned out to recur.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import AccountMenu from '@/components/AccountMenu';
import { useRequireAuth } from '@/lib/use-require-auth';
import { getUsername } from '@/lib/auth';
import { normalizeChurchSlug, churchDisplayName } from '@/lib/slug';
import {
  addGlossaryTerm,
  deleteGlossaryTerm,
  fetchGlossary,
  promoteGlossaryTerm,
  updateGlossaryTerm,
  type GlossarySnapshot,
  type GlossaryTerm,
} from '@/lib/glossary';
import './glossary.css';

/** The single rendering a term forces, if any. */
function targetOf(term: GlossaryTerm): string {
  return Object.values(term.targets)[0] ?? '';
}

export default function GlossaryPage() {
  const gate = useRequireAuth();
  const [church, setChurch] = useState('');
  const [snap, setSnap] = useState<GlossarySnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');

  // Add form
  const [newTerm, setNewTerm] = useState('');
  const [newTarget, setNewTarget] = useState('');

  // Inline edit
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTerm, setEditTerm] = useState('');
  const [editTarget, setEditTarget] = useState('');

  useEffect(() => {
    // Same resolution order as /host: the logged-in username is the church
    // slug in Phase A, with the desk's last-used room as the fallback.
    const user = getUsername();
    setChurch(normalizeChurchSlug(user ?? window.localStorage.getItem('shema-church') ?? 'default'));
  }, []);

  const reload = useCallback(async () => {
    if (!church) return;
    try {
      setSnap(await fetchGlossary(church));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [church]);

  useEffect(() => {
    if (gate === 'ok' && church) void reload();
  }, [gate, church, reload]);

  const readOnly = snap?.source === 'env';

  const churchTerms = useMemo(() => {
    const list = snap?.church ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (t) =>
        t.sourceTerm.toLowerCase().includes(q) ||
        targetOf(t).toLowerCase().includes(q) ||
        (t.notes ?? '').toLowerCase().includes(q),
    );
  }, [snap, query]);

  /** Past service terms, minus any whose source is already a church term. */
  const promotable = useMemo(() => {
    const known = new Set((snap?.church ?? []).map((t) => t.sourceTerm));
    const seen = new Set<string>();
    return (snap?.past ?? []).filter((t) => {
      if (known.has(t.sourceTerm) || seen.has(t.sourceTerm)) return false;
      seen.add(t.sourceTerm);
      return true;
    });
  }, [snap]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    const source = newTerm.trim();
    if (!source) return;
    const target = newTarget.trim();
    return run(async () => {
      await addGlossaryTerm({
        church,
        sourceTerm: source,
        // No rendering given means "this is a name — carry it across as-is".
        behavior: target ? 'translate' : 'keep',
        targets: target ? { en: target } : {},
        serviceOnly: false,
      });
      setNewTerm('');
      setNewTarget('');
    });
  };

  const startEdit = (term: GlossaryTerm) => {
    setEditingId(term.id);
    setEditTerm(term.sourceTerm);
    setEditTarget(targetOf(term));
  };

  const saveEdit = (id: string) =>
    run(async () => {
      const target = editTarget.trim();
      await updateGlossaryTerm(id, {
        sourceTerm: editTerm.trim(),
        behavior: target ? 'translate' : 'keep',
        targets: target ? { en: target } : {},
      });
      setEditingId(null);
    });

  if (gate !== 'ok') return null;

  return (
    <div className="gl-page">
      <div className="gl-head">
        <div>
          <h1 className="gl-title">Glossary</h1>
          <p className="gl-sub">
            Names and terms {churchDisplayName(church) || 'this church'} needs rendered the same way
            every week. <span className="gl-church">{church}</span>
          </p>
        </div>
        <AccountMenu />
      </div>

      {readOnly && (
        <div className="gl-banner">
          This server has no glossary database, so terms are read-only and come from the
          CHURCH_GLOSSARY environment variables.
        </div>
      )}

      <section className="gl-section">
        <div className="gl-section-head">
          <span className="gl-section-title">Church terms · {snap?.church.length ?? 0}</span>
          <input
            className="field"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search terms"
            style={{ width: 200, padding: '7px 11px', fontSize: '0.85rem' }}
          />
        </div>

        {!readOnly && (
          <div className="gl-add">
            <input
              className="field"
              value={newTerm}
              onChange={(e) => setNewTerm(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
              placeholder="Term as spoken, e.g. 목장"
              aria-label="New term"
            />
            <input
              className="field"
              value={newTarget}
              onChange={(e) => setNewTarget(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
              placeholder="Rendering, e.g. Mokjang — blank to keep as-is"
              aria-label="Rendering"
            />
            <button className="gl-btn" onClick={add} disabled={busy || !newTerm.trim()}>
              Add
            </button>
          </div>
        )}

        <div style={{ marginTop: 18 }}>
          <div className="gl-row gl-row-head">
            <span>Term</span>
            <span>Rendering</span>
            <span>Notes</span>
            <span />
          </div>

          {churchTerms.length === 0 && (
            <p className="gl-empty">
              {query ? 'Nothing matches that search.' : 'No church terms yet.'}
            </p>
          )}

          {churchTerms.map((term) =>
            editingId === term.id ? (
              <div className="gl-row" key={term.id}>
                <input
                  className="field"
                  value={editTerm}
                  onChange={(e) => setEditTerm(e.target.value)}
                  aria-label="Edit term"
                  style={{ padding: '7px 10px', fontSize: '0.9rem' }}
                />
                <input
                  className="field"
                  value={editTarget}
                  onChange={(e) => setEditTarget(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(term.id); }}
                  placeholder="blank to keep as-is"
                  aria-label="Edit rendering"
                  style={{ padding: '7px 10px', fontSize: '0.9rem' }}
                />
                <span className="gl-notes">{term.notes}</span>
                <span className="gl-actions">
                  <button className="gl-btn" onClick={() => saveEdit(term.id)} disabled={busy || !editTerm.trim()}>
                    Save
                  </button>
                  <button className="gl-btn" onClick={() => setEditingId(null)} disabled={busy}>
                    Cancel
                  </button>
                </span>
              </div>
            ) : (
              <div className="gl-row" key={term.id}>
                <span className="gl-term">{term.sourceTerm}</span>
                <span className="gl-target">
                  {term.behavior === 'keep' ? <span className="gl-keep">KEPT AS-IS</span> : targetOf(term)}
                </span>
                <span className="gl-notes">{term.notes}</span>
                <span className="gl-actions">
                  <button className="gl-btn" onClick={() => startEdit(term)} disabled={busy || readOnly}>
                    Edit
                  </button>
                  <button
                    className="gl-btn gl-btn-danger"
                    onClick={() => run(() => deleteGlossaryTerm(term.id))}
                    disabled={busy || readOnly}
                  >
                    Delete
                  </button>
                </span>
              </div>
            ),
          )}
        </div>
      </section>

      <section className="gl-section">
        <div className="gl-section-head">
          <span className="gl-section-title">From past services · {promotable.length}</span>
        </div>
        <p className="gl-sub" style={{ marginTop: 0, marginBottom: 10, fontSize: '0.86rem' }}>
          Terms added for a single service. Promote one if it turns out to recur.
        </p>

        {promotable.length === 0 && <p className="gl-empty">Nothing from past services.</p>}

        {promotable.map((term) => (
          <div className="gl-row" key={term.id}>
            <span className="gl-term">{term.sourceTerm}</span>
            <span className="gl-target">
              {term.behavior === 'keep' ? <span className="gl-keep">KEPT AS-IS</span> : targetOf(term)}
            </span>
            <span className="gl-notes">{new Date(term.createdAt).toLocaleDateString()}</span>
            <span className="gl-actions">
              <button
                className="gl-btn"
                onClick={() => run(() => promoteGlossaryTerm(term.id))}
                disabled={busy || readOnly}
              >
                Promote
              </button>
              <button
                className="gl-btn gl-btn-danger"
                onClick={() => run(() => deleteGlossaryTerm(term.id))}
                disabled={busy || readOnly}
              >
                Delete
              </button>
            </span>
          </div>
        ))}
      </section>

      {error && <p className="gl-error">{error}</p>}

      <p className="gl-sub" style={{ marginTop: 34, fontSize: '0.86rem' }}>
        <Link href="/host" style={{ color: 'var(--accent)' }}>← Back to dashboard</Link>
      </p>
    </div>
  );
}
