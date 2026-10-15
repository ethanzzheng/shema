'use client';

/**
 * Chrome shared by the signed-in screens in the homepage's language: the
 * brand mark, the staff bar, the account menu and the segmented control.
 * Pages wrap themselves in <div className="v2 ..."> so the tokens apply.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BookOpen, CaretDown, ClockCounterClockwise, SignOut, User } from '@phosphor-icons/react';
import ShemaMark from '@/components/ShemaMark';
import { clearSession, getUsername } from '@/lib/auth';
import '@/components/home/home.css';
import './app.css';

export function Brand() {
  return <span className="v2-brand"><ShemaMark /><span className="v2-brand-name">Shema</span></span>;
}

/**
 * Glossary and transcripts sit behind one control, with logout demoted to its
 * foot and set apart by a rule, so it is never the first thing a thumb lands
 * on mid-service.
 */
export function AccountMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setUsername(getUsername()), []);

  // Close on outside click and on Escape. A menu that traps an operator
  // mid-service is worse than no menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const logout = () => {
    clearSession();
    router.replace('/login');
  };

  // No username means open dev mode, where staff pages need no session. A
  // plain user glyph reads as "not identified", which is the truth.
  const initial = username ? username.charAt(0).toUpperCase() : null;
  const avatar = (lg?: boolean) => (
    <span className={`ap-avatar${lg ? ' ap-avatar-lg' : ''}`} aria-hidden>
      {initial ?? <User weight="bold" />}
    </span>
  );

  return (
    <div className="ap-acct" ref={rootRef}>
      <button
        type="button"
        className="ap-avatar-btn"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={open ? 'Close account menu' : 'Open account menu'}
        onClick={() => setOpen((v) => !v)}
      >
        {avatar()}
        <CaretDown weight="bold" aria-hidden />
      </button>
      {open && (
        <div className="ap-menu" role="menu">
          <div className="ap-menu-id">
            {avatar(true)}
            <span><strong>{username ?? 'Signed in'}</strong><small>Church account</small></span>
          </div>
          <Link href="/glossary" role="menuitem" onClick={() => setOpen(false)}>
            <BookOpen aria-hidden /><span>Glossary<small>Church names and terms</small></span>
          </Link>
          <Link href="/transcripts" role="menuitem" onClick={() => setOpen(false)}>
            <ClockCounterClockwise aria-hidden /><span>Transcripts<small>What each service said</small></span>
          </Link>
          <hr />
          <button type="button" role="menuitem" className="ap-menu-quiet" onClick={logout}>
            <SignOut aria-hidden /><span>Log out</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** The bar across the top of every signed-in page; the mark goes to the dashboard. */
export function StaffBar({ title, church, children }: {
  title: string;
  church?: string;
  /** Controls between the church chip and the account menu. */
  children?: React.ReactNode;
}) {
  return (
    <header className="ap-bar">
      <Link href="/host" className="ap-bar-brand" title="Dashboard"><Brand /></Link>
      <span className="ap-bar-rule" aria-hidden />
      <span className="ap-bar-title">{title}</span>
      {church && <span className="ap-chip">{church}</span>}
      <span className="ap-bar-fill" />
      {children}
      <AccountMenu />
    </header>
  );
}

export function Seg<T extends string>({ value, options, onChange, label, disabled }: {
  value: T;
  options: { v: T; l: React.ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className="ap-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          className={value === o.v ? 'on' : ''}
          onClick={() => onChange(o.v)}
          title={o.title}
          disabled={disabled}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}
