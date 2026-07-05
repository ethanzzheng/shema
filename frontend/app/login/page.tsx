'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { loginRequest, saveSession, hasValidSession } from '@/lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Already signed in → straight to the dashboard.
  useEffect(() => {
    if (hasValidSession()) router.replace('/host');
  }, [router]);

  const submit = async () => {
    if (busy || !username.trim() || !password) return;
    setBusy(true);
    setError('');
    const result = await loginRequest(username.trim(), password);
    if (result.ok) {
      saveSession(result.token, result.username);
      router.replace('/host');
    } else {
      setError(result.error);
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 420, margin: '0 auto', padding: '5rem 1rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
        <Link href="/" style={{ color: 'var(--text-muted)', fontSize: '1.3rem' }}>←</Link>
        <h1 style={{ fontSize: '1.8rem', fontWeight: 600 }}>Staff login</h1>
      </div>

      <form
        className="card"
        style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1.75rem' }}
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        <div>
          <div className="label">Username</div>
          <input
            className="field"
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={{ width: '100%', padding: '0.7rem 0.9rem', fontSize: '1rem' }}
          />
        </div>
        <div>
          <div className="label">Password</div>
          <input
            className="field"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: '100%', padding: '0.7rem 0.9rem', fontSize: '1rem' }}
          />
        </div>

        {error && (
          <p style={{ color: 'var(--red)', fontSize: '0.88rem' }}>{error}</p>
        )}

        <button
          type="submit"
          className="btn btn-primary btn-lg"
          disabled={busy || !username.trim() || !password}
          style={{ opacity: busy || !username.trim() || !password ? 0.5 : 1 }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
          For church staff. Congregants don&apos;t need an account — just the
          listen link or QR code.
        </p>
      </form>

      <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', textAlign: 'center' }}>
        Don&apos;t have an account? Interested in Shema for your church?{' '}
        <a href="mailto:shematranslate@gmail.com" style={{ whiteSpace: 'nowrap' }}>
          Contact us
        </a>
      </p>
    </div>
  );
}
