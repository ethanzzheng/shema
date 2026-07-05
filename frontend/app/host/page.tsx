'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { clearSession, getUsername } from '@/lib/auth';
import { useRequireAuth } from '@/lib/use-require-auth';
import { normalizeChurchSlug } from '@/lib/slug';

export default function HostDashboard() {
  const gate = useRequireAuth();
  const router = useRouter();
  const [username, setUsername] = useState<string | null>(null);
  const [church, setChurch] = useState('default');

  useEffect(() => {
    setUsername(getUsername());
    // Same "last used church" /speak remembers — keeps the kiosk link in sync.
    setChurch(normalizeChurchSlug(window.localStorage.getItem('shema-church') ?? 'default'));
  }, []);

  if (gate !== 'ok') return null;

  const logout = () => {
    clearSession();
    router.replace('/login');
  };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '4rem 1rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 600 }}>
            {username ? `Welcome, ${username}` : 'Welcome'}
          </h1>
          <p style={{ color: 'var(--text-muted)', marginTop: '0.35rem' }}>
            Everything you need to run a live translated service.
          </p>
        </div>
        <button className="btn btn-ghost" onClick={logout} style={{ fontSize: '0.85rem', padding: '0.5rem 1rem' }}>
          Log out
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.25rem' }}>
        <Link
          href="/speak"
          className="card"
          style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', padding: '1.75rem', borderColor: 'rgba(201,169,97,.45)', color: 'var(--text)' }}
        >
          <div className="label" style={{ color: 'var(--accent)' }}>Broadcast</div>
          <div style={{ fontSize: '1.3rem', fontWeight: 600, fontFamily: 'var(--font-display)' }}>
            Start Broadcasting →
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Capture the sermon from a mic or soundboard and go live. The QR
            code for congregants is on this page.
          </p>
        </Link>

        <Link
          href={`/play/${church}`}
          className="card"
          style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', padding: '1.75rem', color: 'var(--text)' }}
        >
          <div className="label">Receivers</div>
          <div style={{ fontSize: '1.3rem', fontWeight: 600, fontFamily: 'var(--font-display)' }}>
            Kiosk Output →
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            Continuous English audio out of one laptop&apos;s line-out into the
            church&apos;s receiver system. ({church})
          </p>
        </Link>
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
        Congregants never log in — share the listen link or QR from the
        broadcast page.
      </p>
    </div>
  );
}
