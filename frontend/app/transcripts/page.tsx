'use client';

/**
 * Transcript list — a church's archive of services, newest first.
 *
 * This is Shema's first midweek surface: the product is otherwise only opened
 * on a Sunday. So the row has to answer "which service was that?" at a glance,
 * which means the date leads and everything else is secondary.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CaretRight } from '@phosphor-icons/react';
import { StaffBar } from '@/components/app/chrome';
import { useRequireAuth } from '@/lib/use-require-auth';
import { getUsername } from '@/lib/auth';
import { normalizeChurchSlug } from '@/lib/slug';
import {
  durationLabel,
  fetchTranscripts,
  serviceDate,
  serviceYear,
  type TranscriptSummary,
} from '@/lib/transcripts';
import '@/components/app/docs.css';

const LANG_NAMES: Record<string, string> = { ko: 'Korean', en: 'English', zh: 'Mandarin' };
const langName = (code: string) => LANG_NAMES[code] ?? code.toUpperCase();

export default function TranscriptsPage() {
  const gate = useRequireAuth();
  const [church, setChurch] = useState('');
  const [items, setItems] = useState<TranscriptSummary[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const user = getUsername();
    setChurch(normalizeChurchSlug(user ?? window.localStorage.getItem('shema-church') ?? 'default'));
  }, []);

  const load = useCallback(async () => {
    if (!church) return;
    try {
      setItems(await fetchTranscripts(church));
      setError('');
    } catch (err) {
      setError((err as Error).message);
      setItems([]);
    }
  }, [church]);

  useEffect(() => {
    if (gate === 'ok' && church) void load();
  }, [gate, church, load]);

  if (gate !== 'ok') return null;

  return (
    <div className="v2 ap-page">
      <StaffBar title="Transcripts" church={church} />

      <main className="ap-doc">
        <section className="ap-sec">
          <h2>Services {items && <span className="ap-count">{items.length}</span>}</h2>
          <p className="ap-muted">What was said, and what Shema rendered it as.</p>

          {items === null && (
            <ul className="ap-services" aria-busy="true" aria-label="Loading services">
              {[0, 1, 2].map((i) => (
                <li key={i} className="ap-services-skel">
                  <div className="ap-skel" style={{ width: '42%', height: 20 }} />
                  <div className="ap-skel" style={{ width: '28%', height: 14 }} />
                </li>
              ))}
            </ul>
          )}

          {items?.length === 0 && !error && (
            <p className="ap-empty-row">
              No services recorded yet. Transcripts are kept automatically from the next broadcast.
            </p>
          )}

          {items && items.length > 0 && (
            <ul className="ap-services">
              {items.map((t) => (
                <li key={t.id}>
                  <Link href={`/transcripts/${t.id}`}>
                    <span className="ap-services-date">
                      {serviceDate(t.startedAt)} <span>{serviceYear(t.startedAt)}</span>
                    </span>
                    <span className="ap-services-meta">
                      {durationLabel(t.durationSec)} · {t.segmentCount} segments · {langName(t.sourceLang)} to{' '}
                      {t.targetLangs.map(langName).join(', ')}
                      {t.status === 'live' && <span className="ap-rec"><span className="ap-dot" />Recording</span>}
                    </span>
                    <CaretRight className="ap-services-go" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {error && <p className="ap-error" role="alert">{error}</p>}
        </section>
      </main>
    </div>
  );
}
