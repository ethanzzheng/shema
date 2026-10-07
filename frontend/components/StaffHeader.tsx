'use client';

/**
 * The bar across the top of every signed-in staff page.
 *
 * Shared rather than copied: /glossary and /transcripts sit beside each other
 * in the same account menu, and two hand-maintained copies of one bar drift.
 */

import Link from 'next/link';
import AccountMenu from '@/components/AccountMenu';
import ShemaMark from '@/components/ShemaMark';
import './staff-header.css';

export default function StaffHeader({
  title,
  church,
  children,
}: {
  title: string;
  church?: string;
  /** Optional controls sitting between the church chip and the account menu. */
  children?: React.ReactNode;
}) {
  return (
    <header className="sh-bar">
      {/* The dashboard, not the marketing site: everyone here is signed in. */}
      <Link href="/host" className="sh-brand" title="Dashboard">
        <ShemaMark />
        <span className="sh-brand-name">Shema</span>
      </Link>
      <span className="sh-rule" aria-hidden />
      <span className="serif-en sh-title">{title}</span>
      {church && <span className="sh-church">{church}</span>}
      <span className="sh-end">
        {children}
        <AccountMenu />
      </span>
    </header>
  );
}
