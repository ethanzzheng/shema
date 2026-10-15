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
import { ArrowLeft, Check, Copy, FilePdf, MagnifyingGlass, Plus, Trash } from '@phosphor-icons/react';
import { StaffBar, Seg } from '@/components/app/chrome';
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
import '@/components/app/docs.css';

type View = 'bilingual' | 'translation' | 'original';

/** Each language as its own readers name it, for the view switch. */
const NATIVE: Record<string, string> = { ko: '한국어', en: 'English', zh: '中文' };
const ENGLISH_NAME: Record<string, string> = { ko: 'Korean', en: 'English', zh: 'Mandarin' };
const native = (code: string) => NATIVE[code] ?? code.toUpperCase();
const englishName = (code: string) => ENGLISH_NAME[code] ?? code.toUpperCase();

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
      <mark key={`${at}-${n++}`}>
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

  const source = t?.sourceLang ?? 'ko';

  return (
    <div className="v2 ap-page">
      <StaffBar title="Transcripts" church={church} />

      <main className="ap-doc">
        <Link href="/transcripts" className="ap-back"><ArrowLeft aria-hidden /> All services</Link>

        {!data && !error && (
          <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="ap-skel" style={{ width: 'min(320px, 80%)', height: 34 }} />
            <div className="ap-skel" style={{ width: 'min(200px, 50%)', height: 16 }} />
          </div>
        )}

        {t && (
          <>
            <div className="ap-detail-head">
              <h1 className="ap-h1">
                {serviceDate(t.startedAt)} <span className="ap-muted">{serviceYear(t.startedAt)}</span>
              </h1>
              <p className="ap-sub">
                {/* Derived here rather than re-queried: the list computes
                    these in SQL to avoid loading segments, but this page
                    already has every one of them. */}
                <span>{durationLabel(derived.durationSec)} · {derived.count} segments</span>
                {t.status === 'live' && (
                  <span className="ap-rec"><span className="ap-dot" />Recording</span>
                )}
              </p>
            </div>

            <div className="ap-tools">
              <Seg<View>
                label="Show"
                value={view}
                onChange={setView}
                options={[
                  { v: 'bilingual', l: 'Both' },
                  { v: 'translation', l: <span lang={lang}>{native(lang)}</span> },
                  { v: 'original', l: <span lang={source}>{native(source)}</span> },
                ]}
              />
              <label className="ap-search">
                <MagnifyingGlass aria-hidden />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search this service"
                  aria-label="Search this service"
                />
                {query.trim() && (
                  <span className="ap-matches">{hits.length} {hits.length === 1 ? 'match' : 'matches'}</span>
                )}
              </label>
              <div className="ap-tools-actions">
                <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm" onClick={copy}>
                  {copied ? <><Check aria-hidden /> Copied</> : <><Copy aria-hidden /> Copy</>}
                </button>
                <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm" onClick={savePdf}>
                  <FilePdf aria-hidden /> Save as PDF
                </button>
                <button
                  type="button"
                  className="v2-btn v2-btn-ghost v2-btn-sm ap-danger"
                  onClick={() => setConfirming(true)}
                  disabled={busy}
                >
                  <Trash aria-hidden /> Delete
                </button>
              </div>
            </div>
            {/* The language switch drives the export as well as the screen, so
                "English only" needs no second control to discover. */}
            <p className="ap-hint">
              Copy and PDF follow the language shown above
              {view === 'bilingual'
                ? ' (both languages)'
                : ` (${englishName(view === 'translation' ? lang : source)} only)`}.
            </p>

            {confirming && (
              <div className="ap-confirm" role="alertdialog" aria-label="Confirm delete">
                <p>
                  <strong>Delete this transcript permanently?</strong> Services can carry testimonies and prayer
                  requests, so this removes every segment for good and cannot be undone.
                </p>
                <div>
                  <button type="button" className="v2-btn v2-btn-sm ap-btn-danger" onClick={remove} disabled={busy}>
                    {busy ? 'Deleting…' : 'Delete permanently'}
                  </button>
                  <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm" onClick={() => setConfirming(false)} disabled={busy}>
                    Keep
                  </button>
                </div>
              </div>
            )}

            <div className="ap-print-head" aria-hidden>
              <div className="ap-print-title">
                {serviceDate(t.startedAt)} {serviceYear(t.startedAt)}
              </div>
              <div className="ap-print-meta">
                {church} · {durationLabel(derived.durationSec)} · {derived.count} segments
                {query.trim() ? ` · filtered to "${query.trim()}"` : ''}
              </div>
            </div>

            {segments.length === 0 ? (
              <p className="ap-empty-row">This service has no segments recorded.</p>
            ) : (
              <div ref={streamRef}>
                <ol className={`ap-read${view === 'bilingual' ? '' : ' ap-read-single'}`}>
                  {(query.trim() ? hits : segments).map((s) => (
                    <li key={s.id} id={`seg-${s.seq}`}>
                      <time>{offsetLabel(s.offsetMs)}</time>
                      {view !== 'translation' && (
                        <p className="ap-read-src" lang={t.sourceLang}>
                          {marked(s.sourceText, query.trim())}
                        </p>
                      )}
                      {view !== 'original' && (
                        <p lang={lang}>
                          {marked(s.translations[lang]?.sermon ?? '', query.trim())}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </>
        )}

        {error && <p className="ap-error" role="alert">{error}</p>}
      </main>

      {sel && (
        <div className="ap-sel-pop" style={{ left: sel.x, top: sel.y }}>
          <button
            type="button"
            className="ap-float"
            onClick={() => {
              // Hand the term to the glossary's quick-add rather than making
              // the operator retype a name they just found being mangled.
              const term = encodeURIComponent(sel.text);
              router.push(`/glossary?add=${term}`);
            }}
          >
            <Plus weight="bold" aria-hidden /> Add “{sel.text.length > 18 ? `${sel.text.slice(0, 18)}…` : sel.text}” to glossary
          </button>
        </div>
      )}
    </div>
  );
}
