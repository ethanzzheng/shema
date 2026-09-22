'use client';

/**
 * Glossary management — the permanent, church-scope terms, plus the one-off
 * terms past services left behind.
 *
 * The broadcast desk's Terms card is for the heat of a service; this is where
 * the glossary gets tidied afterwards: correct a rendering, drop a mistake, or
 * promote a song title that turned out to recur. Shares the desk's top bar and
 * section tabs so the two read as one app.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import AccountMenu from '@/components/AccountMenu';
import StaffNav from '@/components/StaffNav';
import ShemaMark from '@/components/ShemaMark';
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

/** Term → rendering, or the badge that says it is carried across untouched. */
function Rendering({ term }: { term: GlossaryTerm }) {
  if (term.behavior === 'keep') return <span className="gl-tag gl-tag-keep">kept as-is</span>;
  return (
    <>
      <span className="gl-arrow" aria-hidden>→</span>
      <span>{targetOf(term)}</span>
    </>
  );
}

export default function GlossaryPage() {
  const gate = useRequireAuth();
  const [church, setChurch] = useState('');
  const [snap, setSnap] = useState<GlossarySnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');

  const [newTerm, setNewTerm] = useState('');
  const [newTarget, setNewTarget] = useState('');

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
    <div className="gl-root">
      {/* Mirrors the desk's top bar so the tabs never move between pages. */}
      <header className="gl-bar">
        <Link href="/" className="gl-brand" title="Home">
          <ShemaMark />
          <span className="gl-brand-name">Shema</span>
        </Link>
        <span className="gl-bar-rule" aria-hidden />
        <span className="serif-en gl-bar-title">Glossary</span>
        <StaffNav />
        <span className="gl-bar-church">{church}</span>
        <span className="gl-bar-end">
          <AccountMenu />
        </span>
      </header>

      <main className="gl-main">
        <p className="gl-lede">
          Names and terms {churchDisplayName(church) || 'this church'} needs said the same way every
          week. These are read before every translation, and are biased into speech recognition when a
          broadcast starts.
        </p>

        {readOnly && (
          <div className="gl-banner">
            This server has no glossary database, so terms are read-only and come from the
            CHURCH_GLOSSARY environment variables.
          </div>
        )}

        <section className="gl-section">
          <div className="gl-section-head">
            <div>
              <span className="gl-section-title">Church terms</span>
              <span className="gl-count">{snap?.church.length ?? 0}</span>
              <p className="gl-section-note">Permanent — in force for every service.</p>
            </div>
            <input
              className="field"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search terms"
              style={{ width: 190, padding: '8px 12px', fontSize: '0.86rem' }}
            />
          </div>

          {!readOnly && (
            <div className="gl-add">
              <input
                className="field"
                value={newTerm}
                onChange={(e) => setNewTerm(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
                placeholder="As spoken, e.g. 목장"
                aria-label="Term as spoken"
              />
              <input
                className="field"
                value={newTarget}
                onChange={(e) => setNewTarget(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
                placeholder="Comes out as, e.g. Mokjang"
                aria-label="Comes out as"
              />
              <button className="gl-btn gl-btn-primary" onClick={add} disabled={busy || !newTerm.trim()}>
                Add term
              </button>
              <span className="gl-add-hint">
                Leave the second box empty to keep a name exactly as it is said.
              </span>
            </div>
          )}

          <div className="gl-list">
            {churchTerms.length === 0 && (
              <p className="gl-empty">
                {query
                  ? `Nothing matches “${query.trim()}”.`
                  : 'No church terms yet. Add the names your congregation hears every week.'}
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
                    style={{ padding: '8px 11px', fontSize: '0.92rem' }}
                  />
                  <input
                    className="field"
                    value={editTarget}
                    onChange={(e) => setEditTarget(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(term.id); }}
                    placeholder="blank to leave it unchanged"
                    aria-label="Edit what it comes out as"
                    style={{ padding: '8px 11px', fontSize: '0.92rem' }}
                  />
                  <span className="gl-actions">
                    <button className="gl-btn gl-btn-primary" onClick={() => saveEdit(term.id)} disabled={busy || !editTerm.trim()}>
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
                  <span className="gl-rendering">
                    <Rendering term={term} />
                  </span>
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
            <div>
              <span className="gl-section-title">From past services</span>
              <span className="gl-count">{promotable.length}</span>
              <p className="gl-section-note">
                Added for a single service. Promote one if it turns out to recur.
              </p>
            </div>
          </div>

          <div className="gl-list">
            {promotable.length === 0 && (
              <p className="gl-empty">Nothing yet — terms added at the desk for one service land here.</p>
            )}

            {promotable.map((term) => (
              <div className="gl-row" key={term.id}>
                <span className="gl-term">{term.sourceTerm}</span>
                <span className="gl-rendering">
                  <Rendering term={term} />
                  <span className="gl-tag-date">{new Date(term.createdAt).toLocaleDateString()}</span>
                </span>
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
          </div>
        </section>

        {error && <p className="gl-error">{error}</p>}
      </main>
    </div>
  );
}
