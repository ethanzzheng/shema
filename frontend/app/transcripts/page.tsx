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
import StaffHeader from '@/components/StaffHeader';
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
import './transcripts.css';

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
    <div className="tr-root">
      <StaffHeader title="Transcripts" church={church} />

      <main className="tr-main tr-main-list">
        <div className="tr-head">
          <div>
            <span className="tr-head-title">Services</span>
            {items && <span className="tr-count">{items.length}</span>}
            <p className="tr-head-note">What was said, and what Shema rendered it as.</p>
          </div>
        </div>

        {items === null && (
          <div className="tr-list" aria-busy="true" aria-label="Loading services">
            {[0, 1, 2].map((i) => (
              <div className="tr-item" key={i}>
                <div>
                  <div className="tr-skel" style={{ width: '42%', height: '1.05rem' }} />
                  <div className="tr-skel" style={{ width: '28%', marginTop: 10, height: '0.84rem' }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {items?.length === 0 && !error && (
          <p className="tr-empty">
            No services recorded yet. Transcripts are kept automatically from the next broadcast.
          </p>
        )}

        {items && items.length > 0 && (
          <div className="tr-list">
            {items.map((t) => (
              <Link key={t.id} href={`/transcripts/${t.id}`} className="tr-item">
                <div>
                  <div className="tr-item-date">
                    {serviceDate(t.startedAt)}
                    <span className="tr-item-year">{serviceYear(t.startedAt)}</span>
                  </div>
                  <div className="tr-item-meta">
                    <span>{durationLabel(t.durationSec)}</span>
                    <span className="tr-num">{t.segmentCount} segments</span>
                    <span className="tr-num">
                      {t.sourceLang.toUpperCase()} to {t.targetLangs.map((l) => l.toUpperCase()).join(', ')}
                    </span>
                    {t.status === 'live' && (
                      <span className="tr-live">
                        <span className="tr-live-dot" aria-hidden />
                        Recording
                      </span>
                    )}
                  </div>
                </div>
                <span className="tr-go" aria-hidden>→</span>
              </Link>
            ))}
          </div>
        )}

        {error && <p className="tr-error">{error}</p>}
      </main>
    </div>
  );
}
