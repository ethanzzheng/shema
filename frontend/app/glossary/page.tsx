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
import { ArrowRight, ArrowUp, MagnifyingGlass, PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import { StaffBar } from '@/components/app/chrome';
import { useRequireAuth } from '@/lib/use-require-auth';
import { getUsername } from '@/lib/auth';
import { normalizeChurchSlug } from '@/lib/slug';
import {
  addGlossaryTerm,
  deleteGlossaryTerm,
  fetchGlossary,
  promoteGlossaryTerm,
  updateGlossaryTerm,
  type GlossarySnapshot,
  type GlossaryTerm,
} from '@/lib/glossary';
import '@/components/app/docs.css';

/** The single rendering a term forces, if any. */
function targetOf(term: GlossaryTerm): string {
  return Object.values(term.targets)[0] ?? '';
}

/** The script a term is written in, so Korean wraps between words. */
function langOf(text: string): string | undefined {
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  return undefined;
}

/** Term → rendering, or the badge that says it is carried across untouched. */
function Rendering({ term }: { term: GlossaryTerm }) {
  return (
    <>
      <ArrowRight className="ap-rows-arrow" aria-hidden />
      {term.behavior === 'keep'
        ? <span className="ap-tag">Kept as is</span>
        : <span className="ap-rows-v">{targetOf(term)}</span>}
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
    // ?add= arrives from a transcript, where the operator just saw a name
    // come out wrong and selected it. Prefill rather than make them retype it.
    const add = new URLSearchParams(window.location.search).get('add');
    if (add) setNewTerm(add);
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
    <div className="v2 ap-page">
      <StaffBar title="Glossary" church={church} />

      <main className="ap-doc">
        {readOnly && (
          <div className="ap-banner">
            This server has no glossary database, so terms are read-only and come from the
            CHURCH_GLOSSARY environment variables.
          </div>
        )}

        <section className="ap-sec">
          <div className="ap-sec-head">
            <div>
              <h2>Church terms <span className="ap-count">{snap?.church.length ?? 0}</span></h2>
              <p className="ap-muted">Permanent: in force for every service.</p>
            </div>
            <label className="ap-search">
              <MagnifyingGlass aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search terms"
              />
            </label>
          </div>

          {!readOnly && (
            <>
              <form className="ap-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
                <input
                  className="v2-input"
                  value={newTerm}
                  onChange={(e) => setNewTerm(e.target.value)}
                  placeholder="As spoken, e.g. 목장"
                  aria-label="Term as spoken"
                />
                <input
                  className="v2-input"
                  value={newTarget}
                  onChange={(e) => setNewTarget(e.target.value)}
                  placeholder="Comes out as, e.g. Mokjang"
                  aria-label="Comes out as"
                />
                <button type="submit" className="v2-btn v2-btn-ink" disabled={busy || !newTerm.trim()}>
                  <Plus weight="bold" aria-hidden /> Add term
                </button>
              </form>
              <p className="ap-hint">Leave the second box empty to keep a name exactly as it is said.</p>
            </>
          )}

          <ul className="ap-rows">
            {churchTerms.length === 0 && (
              <li className="ap-empty-row">
                {query
                  ? `Nothing matches “${query.trim()}”.`
                  : 'No church terms yet. Add the names your congregation hears every week.'}
              </li>
            )}

            {churchTerms.map((term) => (
              <li key={term.id}>
                {editingId === term.id ? (
                  <form className="ap-edit" onSubmit={(e) => { e.preventDefault(); saveEdit(term.id); }}>
                    <input
                      className="v2-input"
                      value={editTerm}
                      onChange={(e) => setEditTerm(e.target.value)}
                      aria-label="Edit term"
                    />
                    <input
                      className="v2-input"
                      value={editTarget}
                      onChange={(e) => setEditTarget(e.target.value)}
                      placeholder="blank to leave it unchanged"
                      aria-label="Edit what it comes out as"
                    />
                    <button type="submit" className="v2-btn v2-btn-ink v2-btn-sm" disabled={busy || !editTerm.trim()}>
                      Save
                    </button>
                    <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm" onClick={() => setEditingId(null)} disabled={busy}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="ap-rows-k" lang={langOf(term.sourceTerm)}>{term.sourceTerm}</span>
                    <Rendering term={term} />
                    <span className="ap-rows-actions">
                      <button type="button" aria-label={`Edit ${term.sourceTerm}`} title="Edit" onClick={() => startEdit(term)} disabled={busy || readOnly}>
                        <PencilSimple aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${term.sourceTerm}`}
                        title="Delete"
                        className="ap-danger"
                        onClick={() => run(() => deleteGlossaryTerm(term.id))}
                        disabled={busy || readOnly}
                      >
                        <Trash aria-hidden />
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="ap-sec">
          <h2>From past services <span className="ap-count">{promotable.length}</span></h2>
          <p className="ap-muted">Added for a single service. Promote one if it turns out to recur.</p>

          <ul className="ap-rows">
            {promotable.length === 0 && (
              <li className="ap-empty-row">Nothing yet. Terms added at the desk for one service land here.</li>
            )}

            {promotable.map((term) => (
              <li key={term.id}>
                <span className="ap-rows-k" lang={langOf(term.sourceTerm)}>{term.sourceTerm}</span>
                <Rendering term={term} />
                <span className="ap-rows-date">{new Date(term.createdAt).toLocaleDateString()}</span>
                <span className="ap-rows-actions">
                  <button
                    type="button"
                    className="ap-text-btn"
                    onClick={() => run(() => promoteGlossaryTerm(term.id))}
                    disabled={busy || readOnly}
                  >
                    <ArrowUp aria-hidden /> Promote
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${term.sourceTerm}`}
                    title="Delete"
                    className="ap-danger"
                    onClick={() => run(() => deleteGlossaryTerm(term.id))}
                    disabled={busy || readOnly}
                  >
                    <Trash aria-hidden />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>

        {error && <p className="ap-error" role="alert">{error}</p>}
      </main>
    </div>
  );
}
