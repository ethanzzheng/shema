'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, BookOpen, Broadcast, CaretRight, ClockCounterClockwise, SpeakerHigh } from '@phosphor-icons/react';
import { getUsername } from '@/lib/auth';
import { AccountMenu, Brand } from '@/components/app/chrome';
import { useRequireAuth } from '@/lib/use-require-auth';
import { normalizeChurchSlug } from '@/lib/slug';

export default function HostDashboard() {
  const gate = useRequireAuth();
  const [username, setUsername] = useState<string | null>(null);
  const [church, setChurch] = useState('default');

  useEffect(() => {
    const user = getUsername();
    setUsername(user);
    // Username = church slug in Phase A; fall back to /speak's last-used room.
    setChurch(normalizeChurchSlug(user ?? window.localStorage.getItem('shema-church') ?? 'default'));
  }, []);

  if (gate !== 'ok') return null;

  return (
    <div className="v2 ap-page">
      <header className="ap-bar">
        <Brand />
        <span className="ap-bar-fill" />
        <AccountMenu />
      </header>
      <main className="ap-home">
        <div className="v2-eyebrow">{church}</div>
        <h1 className="ap-h1">{username ? `Welcome, ${username}.` : 'Welcome.'}</h1>
        <p className="ap-muted">Everything you need to run a live translated service.</p>

        <Link href="/speak" className="ap-action ap-action-primary">
          <span className="ap-action-icon"><Broadcast weight="bold" aria-hidden /></span>
          <span className="ap-action-text">
            <strong>Start broadcasting</strong>
            <span>Capture the sermon from a mic or soundboard and go live. The QR code for congregants is on this page.</span>
          </span>
          <ArrowRight weight="bold" className="ap-action-go" aria-hidden />
        </Link>
        <Link href={`/play/${church}`} className="ap-action">
          <span className="ap-action-icon"><SpeakerHigh weight="bold" aria-hidden /></span>
          <span className="ap-action-text">
            <strong>Kiosk output</strong>
            <span>Continuous translated audio out of one laptop&apos;s line-out into the church&apos;s receiver system.</span>
          </span>
          <ArrowRight weight="bold" className="ap-action-go" aria-hidden />
        </Link>

        <div className="ap-home-links">
          <Link href="/glossary"><BookOpen aria-hidden /><span><strong>Glossary</strong><small>Church names and terms</small></span><CaretRight aria-hidden /></Link>
          <Link href="/transcripts"><ClockCounterClockwise aria-hidden /><span><strong>Transcripts</strong><small>What each service said</small></span><CaretRight aria-hidden /></Link>
        </div>
        <p className="ap-foot-note">Congregants never log in. Share the listen link or QR code from the broadcast desk.</p>
      </main>
    </div>
  );
}
