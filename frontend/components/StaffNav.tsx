'use client';

/**
 * Section tabs for the signed-in staff surfaces.
 *
 * The desk and the glossary are two halves of one job — fix a name at the
 * desk during the service, tidy it afterwards — and moving between them used
 * to mean going through the account menu. A compact segmented control in the
 * top bar of both makes them read as one app.
 *
 * Deliberately small and quiet: /speak is a live console, and a chrome-heavy
 * nav competing with the on-air state would be worse than the extra click.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BookOpenText, Broadcast } from '@phosphor-icons/react';
import './staff-nav.css';

const TABS = [
  { href: '/speak', label: 'Desk', Icon: Broadcast },
  { href: '/glossary', label: 'Glossary', Icon: BookOpenText },
];

export default function StaffNav() {
  const pathname = usePathname();
  return (
    <nav className="sn" aria-label="Staff sections">
      {TABS.map(({ href, label, Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={`sn-tab${active ? ' sn-tab-on' : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={14} weight={active ? 'fill' : 'regular'} aria-hidden />
            <span className="sn-tab-label">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
