'use client';

/**
 * One service, read back.
 *
 * A sermon is ~400 segments of bilingual text, so this is a reading surface
 * rather than a table: source and rendering run side by side with the position
 * in a gutter, and nothing is boxed. The operator uses it to spot names Shema
 * got wrong, which is why selecting text offers to add it to the glossary.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import StaffHeader from '@/components/StaffHeader';
import { useRequireAuth } from '@/lib/use-require-auth';
import { getUsername } from '@/lib/auth';
import { normalizeChurchSlug } from '@/lib/slug';
import {
  buildExport,
  deleteTranscript,
  durationLabel,
  fetchTranscript,
  offsetLabel,
  serviceDate,
  serviceYear,
  type ExportMode,
  type TranscriptSegment,
  type TranscriptSummary,
} from '@/lib/transcripts';
import '../transcripts.css';

type View = 'bilingual' | 'translation' | 'original';

/** Split on a search term so matches can be marked without dangerous HTML. */
function marked(text: string, needle: string): React.ReactNode {
  if (!needle) return text;
  const lower = text.toLowerCase();
  const find = needle.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let n = 0;
  for (;;) {
    const at = lower.indexOf(find, i);
    if (at === -1) break;
    if (at > i) out.push(text.slice(i, at));
    out.push(
      <mark className="tr-hit" key={`${at}-${n++}`}>
        {text.slice(at, at + find.length)}
      </mark>,
    );
    i = at + find.length;
  }
  out.push(text.slice(i));
  return out;
}

export default function TranscriptDetailPage() {
  const gate = useRequireAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id as string;

  const [church, setChurch] = useState('');
  const [data, setData] = useState<{ transcript: TranscriptSummary; segments: TranscriptSegment[] } | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('bilingual');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const user = getUsername();
    setChurch(normalizeChurchSlug(user ?? window.localStorage.getItem('shema-church') ?? 'default'));
  }, []);

  useEffect(() => {
    if (gate !== 'ok' || !id) return;
    let cancelled = false;
    fetchTranscript(id)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) { setError((err as Error).message); setData(null); } });
    return () => { cancelled = true; };
  }, [gate, id]);

  const lang = data?.transcript.targetLangs[0] ?? 'en';

  const segments = data?.segments ?? [];
  const derived = useMemo(
    () => ({
      count: segments.length,
      durationSec: segments.length ? Math.round(segments[segments.length - 1].offsetMs / 1000) : null,
    }),
    [segments],
  );
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return segments.filter(
      (s) =>
        s.sourceText.toLowerCase().includes(q) ||
        (s.translations[lang]?.sermon ?? '').toLowerCase().includes(q),
    );
  }, [segments, query, lang]);

  // Selecting text is how a mangled name becomes a glossary term, so the
  // action appears where the selection is rather than in a toolbar.
  useEffect(() => {
    const onUp = () => {
      const s = window.getSelection();
      const text = s?.toString().trim() ?? '';
      if (!text || text.length > 80 || !streamRef.current || !s?.rangeCount) {
        setSel(null);
        return;
      }
      const range = s.getRangeAt(0);
      if (!streamRef.current.contains(range.commonAncestorContainer)) {
        setSel(null);
        return;
      }
      const r = range.getBoundingClientRect();
      setSel({ text, x: r.left + r.width / 2, y: r.top - 8 });
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('selectionchange', () => {
      if (!window.getSelection()?.toString().trim()) setSel(null);
    });
    return () => document.removeEventListener('mouseup', onUp);
  }, []);

  const exportText = useCallback(
    (mode: ExportMode) => (data ? buildExport(data.transcript, data.segments, mode, lang) : ''),
    [data, lang],
  );

  const copy = async () => {
    const mode: ExportMode = view === 'original' ? 'original' : view === 'translation' ? 'translation' : 'bilingual';
    try {
      await navigator.clipboard.writeText(exportText(mode));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy. Select the text and copy manually.');
    }
  };

  /**
   * The browser's own print pipeline, not a JS PDF library: none of them ship
   * Hangul glyphs, so Korean would need a ~5MB font embedded at runtime. Print
   * already has the page's fonts and typesets both languages correctly, and
   * every platform's dialog offers Save as PDF. It prints whatever the view is
   * showing, so English-only and Korean-only come out of the same control.
   */
  const savePdf = () => {
    // The tab title becomes the PDF's default filename on most platforms.
    const previous = document.title;
    if (data) {
      document.title = `Shema ${church} ${data.transcript.startedAt.slice(0, 10)}`;
    }
    window.print();
    setTimeout(() => { document.title = previous; }, 500);
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteTranscript(id);
      router.replace('/transcripts');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      setConfirming(false);
    }
  };

  if (gate !== 'ok') return null;

  const t = data?.transcript;

  return (
    <div className="tr-root">
      <StaffHeader title="Transcripts" church={church} />

      <main className="tr-main tr-main-detail">
        <Link href="/transcripts" className="tr-back">← All services</Link>

        {!data && !error && (
          <div aria-busy="true">
            <div className="tr-skel" style={{ width: 320, height: '1.6rem' }} />
            <div className="tr-skel" style={{ width: 200, height: '0.88rem', marginTop: 12 }} />
          </div>
        )}

        {t && (
          <>
            <div className="tr-detail-head">
              <div>
                <h1 className="tr-title">
                  {serviceDate(t.startedAt)} <span className="tr-item-year">{serviceYear(t.startedAt)}</span>
                </h1>
                <div className="tr-sub">
                  {/* Derived here rather than re-queried: the list computes
                      these in SQL to avoid loading segments, but this page
                      already has every one of them. */}
                  <span>{durationLabel(derived.durationSec)}</span>
                  <span className="tr-num">{derived.count} segments</span>
                  {t.status === 'live' && (
                    <span className="tr-live"><span className="tr-live-dot" aria-hidden />Recording</span>
                  )}
                </div>
              </div>
            </div>

            <div className="tr-tools">
              <div className="toggle-group">
                {(['bilingual', 'translation', 'original'] as View[]).map((v) => (
                  <button
                    key={v}
                    className={`toggle-opt${view === v ? ' active' : ''}`}
                    onClick={() => setView(v)}
                    style={{ fontFamily: 'var(--font-sans)', fontSize: 12, textTransform: 'none', letterSpacing: 0 }}
                  >
                    {v === 'bilingual' ? 'Both' : v === 'translation' ? 'English' : '한국어'}
                  </button>
                ))}
              </div>
              <input
                className="field tr-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search this service"
                aria-label="Search this service"
              />
              {query.trim() && (
                <span className="tr-hits">{hits.length} {hits.length === 1 ? 'match' : 'matches'}</span>
              )}
              <button className="tr-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
              <button className="tr-btn" onClick={savePdf}>Save as PDF</button>
              <button className="tr-btn tr-btn-danger" onClick={() => setConfirming(true)} disabled={busy}>
                Delete
              </button>
            </div>
            {/* The language switch drives the export as well as the screen, so
                "English only" needs no second control to discover. */}
            <p className="tr-export-note">
              Copy and PDF follow the language shown above
              {view === 'bilingual' ? ' (both languages)' : view === 'translation' ? ' (English only)' : ' (Korean only)'}.
            </p>

            {confirming && (
              <div className="tr-confirm" role="alertdialog" aria-label="Confirm delete">
                Delete this transcript permanently? Services can carry testimonies and prayer requests, so
                this removes every segment for good and cannot be undone.
                <div className="tr-confirm-actions">
                  <button className="tr-btn tr-btn-danger" onClick={remove} disabled={busy}>
                    {busy ? 'Deleting…' : 'Delete permanently'}
                  </button>
                  <button className="tr-btn" onClick={() => setConfirming(false)} disabled={busy}>Keep</button>
                </div>
              </div>
            )}

            <div className="tr-print-head" aria-hidden>
              <div className="tr-print-title">
                {serviceDate(t.startedAt)} {serviceYear(t.startedAt)}
              </div>
              <div className="tr-print-meta">
                {church} · {durationLabel(derived.durationSec)} · {derived.count} segments
                {query.trim() ? ` · filtered to "${query.trim()}"` : ''}
              </div>
            </div>

            {segments.length === 0 ? (
              <p className="tr-empty">This service has no segments recorded.</p>
            ) : (
              <div
                className={`tr-stream${view === 'bilingual' ? '' : ' tr-stream-single'}`}
                ref={streamRef}
              >
                {(query.trim() ? hits : segments).map((s) => (
                  <div className="tr-seg" key={s.id} id={`seg-${s.seq}`}>
                    <span className="tr-seg-time">{offsetLabel(s.offsetMs)}</span>
                    {view !== 'translation' && (
                      <p className="serif-kr tr-seg-source" lang={t.sourceLang}>
                        {marked(s.sourceText, query.trim())}
                      </p>
                    )}
                    {view !== 'original' && (
                      <p className="tr-seg-target" lang={lang}>
                        {marked(s.translations[lang]?.sermon ?? '', query.trim())}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {error && <p className="tr-error">{error}</p>}
      </main>

      {sel && (
        <div className="tr-sel" style={{ left: sel.x, top: sel.y }}>
          <button
            className="tr-btn"
            onClick={() => {
              // Hand the term to the glossary's quick-add rather than making
              // the operator retype a name they just found being mangled.
              const term = encodeURIComponent(sel.text);
              router.push(`/glossary?add=${term}`);
            }}
          >
            Add “{sel.text.length > 18 ? `${sel.text.slice(0, 18)}…` : sel.text}” to glossary
          </button>
        </div>
      )}
    </div>
  );
}
