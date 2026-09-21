'use client';

/**
 * Account menu for the signed-in surfaces (/host and /speak).
 *
 * Replaces a bare "Log out" button sitting in the corner of the dashboard.
 * Logout is a once-a-day action taking prime real estate, while the things an
 * operator actually reaches for mid-service (the glossary, shortly) had
 * nowhere to live. Both now sit behind one control, with logout demoted to the
 * foot of it and separated by a rule so it is never the first thing a thumb
 * lands on during a service.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SignOut, BookOpenText, CaretDown, User } from '@phosphor-icons/react';
import { clearSession, getUsername } from '@/lib/auth';
import './account-menu.css';

const ICON_WEIGHT = 'regular' as const;
const ICON_SIZE = 17;

export default function AccountMenu() {
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

  // No username means open dev mode (backend `authRequired: false`), where
  // /host is reachable without a session. A literal "?" avatar reads as an
  // error; a plain user glyph reads as "not identified", which is the truth.
  const initial = username ? username.charAt(0).toUpperCase() : null;
  const avatar = (
    <span className="am-avatar" aria-hidden>
      {initial ?? <User size={14} weight={ICON_WEIGHT} />}
    </span>
  );

  return (
    <div className="am-root" ref={rootRef}>
      <button
        type="button"
        className="am-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={open ? 'Close account menu' : 'Open account menu'}
      >
        {avatar}
        <CaretDown size={13} weight="bold" className={open ? 'am-caret am-caret-open' : 'am-caret'} />
      </button>

      {open && (
        <div className="am-panel am-panel-menu">
          <div className="am-identity">
            {avatar}
            <span>
              <span className="am-identity-name">{username ?? 'Signed in'}</span>
              <span className="am-identity-sub">Church account</span>
            </span>
          </div>

          <button type="button" className="am-item" disabled>
            <BookOpenText size={ICON_SIZE} weight={ICON_WEIGHT} />
            <span className="am-item-body">
              <span className="am-item-line">
                Glossary
                <span className="am-soon">Soon</span>
              </span>
              <span className="am-item-sub">Church names and terms</span>
            </span>
          </button>

          <div className="am-rule" />

          <button type="button" className="am-item am-item-quiet" onClick={logout}>
            <SignOut size={ICON_SIZE} weight={ICON_WEIGHT} />
            <span>Log out</span>
          </button>
        </div>
      )}
    </div>
  );
}
