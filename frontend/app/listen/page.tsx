'use client';

/**
 * /listen without a church in the path.
 *   - /listen?church=<slug> (or legacy ?room=) → straight into that room.
 *   - Bare /listen → ask for the church code, then go to /listen/[church].
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import ListenerView from '@/components/ListenerView';
import { normalizeChurchSlug } from '@/lib/slug';
import { ArrowRight } from '@phosphor-icons/react';
import { Brand } from '@/components/app/chrome';
import '@/components/app/listener.css';

export default function ListenEntryPage() {
  const router = useRouter();
  // null = still reading the URL (first client render), '' = no slug given.
  const [church, setChurch] = useState<string | null>(null);
  const [code, setCode] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const slug = params.get('church') ?? params.get('room');
    setChurch(slug ? normalizeChurchSlug(slug) : '');
  }, []);

  if (church === null) return null;
  if (church) return <ListenerView church={church} />;

  const join = () => {
    const slug = normalizeChurchSlug(code);
    router.push(`/listen/${slug}`);
  };

  return (
    <div className="v2">
      <main className="ap-listen ap-join ls-join">
        <Brand />
        <h1>Join your church</h1>
        <p className="ap-muted">Enter the church code from your bulletin or the QR sign.</p>
        <input
          className="v2-input"
          autoFocus
          placeholder="e.g. grace-church"
          aria-label="Church code"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) join(); }}
        />
        <button type="button" className="v2-btn v2-btn-ink v2-form-submit" onClick={join} disabled={!code.trim()}>
          Listen <ArrowRight weight="bold" aria-hidden />
        </button>
        <figure className="v2-plate ap-join-plate" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/pulpit.svg" alt="" />
        </figure>
      </main>
    </div>
  );
}
