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
    <div style={{ maxWidth: 460, margin: '0 auto', padding: '4rem 1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <h1 style={{ fontSize: '1.65rem', fontWeight: 600 }}>Join your church</h1>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem', padding: '1.5rem' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.95rem' }}>
          Enter the church code from your bulletin or QR sign.
        </p>
        <input
          className="field"
          autoFocus
          placeholder="e.g. grace-church"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && code.trim()) join(); }}
          style={{ padding: '0.7rem 0.9rem', fontSize: '1rem' }}
        />
        <button className="btn btn-primary btn-lg" onClick={join} disabled={!code.trim()} style={{ opacity: code.trim() ? 1 : 0.5 }}>
          Listen
        </button>
      </div>
    </div>
  );
}
