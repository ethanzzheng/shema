'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Eye, EyeSlash } from '@phosphor-icons/react';
import { loginRequest, saveSession, hasValidSession } from '@/lib/auth';
import './login.css';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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

  const disabled = busy || !username.trim() || !password;

  return (
    <div className="lg-split">
      <section className="lg-form-side">
        <div className="lg-form-inner">
          <Link href="/" className="lg-back lg-in lg-d1">← Back to Shema homepage</Link>

          <h1 className="lg-title lg-in lg-d2">Login</h1>
          <p className="lg-sub lg-in lg-d2">
            Sign in to run a broadcast. Congregants don&apos;t need an account —
            just the listen link or the QR code at the welcome desk.
          </p>

          <form
            onSubmit={(e) => { e.preventDefault(); submit(); }}
            style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
          >
            <div className="lg-in lg-d3">
              <label className="lg-field-label" htmlFor="lg-username">Username</label>
              <div className="lg-well">
                <input
                  id="lg-username"
                  autoFocus
                  autoComplete="username"
                  placeholder="Your church's username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </div>
            </div>

            <div className="lg-in lg-d4">
              <label className="lg-field-label" htmlFor="lg-password">Password</label>
              <div className="lg-well lg-pw">
                <input
                  id="lg-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="lg-pw-toggle"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeSlash size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            {error && <p className="lg-error" role="alert">{error}</p>}

            {/* The animation lives on the wrapper, not the button. A CSS
                animation with fill-mode:both wins over inline styles, so
                animating the button itself pinned it to opacity 1 and the
                disabled state became invisible. */}
            <div className="lg-in lg-d5">
              <button type="submit" className="btn btn-primary lg-submit" disabled={disabled}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </div>
          </form>

          <p className="lg-note lg-in lg-d6" style={{ marginTop: 22 }}>
            Interested in Shema for your church?{' '}
            <a href="mailto:shematranslate@gmail.com">Get in touch</a> — we&apos;ll
            set up a live demo service.
          </p>
        </div>
      </section>

      <section className="lg-plate-side" aria-hidden>
        <div className="lg-plate" />
      </section>
    </div>
  );
}
