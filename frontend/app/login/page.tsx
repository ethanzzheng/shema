'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Eye, EyeSlash } from '@phosphor-icons/react';
import { loginRequest, saveSession, hasValidSession } from '@/lib/auth';
import { Brand } from '@/components/app/chrome';

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
    <div className="v2 ap-login">
      <div className="ap-login-form">
        <Link href="/" className="ap-back">← Back to Shema</Link>
        <Brand />
        <h1>Sign in</h1>
        <p className="ap-muted">
          Sign in to run a broadcast. Congregants don&apos;t need an account: just the listen link or the QR code at the welcome desk.
        </p>
        <form className="v2-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="v2-field">
            <label htmlFor="lg-username">Username</label>
            <input
              id="lg-username"
              className="v2-input"
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Your church's username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="lg-password">Password</label>
            <div className="ap-pass">
              <input
                id="lg-password"
                className="v2-input"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeSlash aria-hidden /> : <Eye aria-hidden />}
              </button>
            </div>
          </div>
          {error && <p className="ap-error" role="alert">{error}</p>}
          <button type="submit" className="v2-btn v2-btn-ink v2-form-submit" aria-busy={busy || undefined} disabled={disabled}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="ap-foot-note">
          Interested in Shema for your church?{' '}
          <a href="mailto:shematranslate@gmail.com">Get in touch</a> and we&apos;ll set up a live demo service.
        </p>
      </div>
      <figure className="v2-plate ap-login-plate" aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/sanctuary.svg" alt="" />
      </figure>
    </div>
  );
}
