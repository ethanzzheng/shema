'use client';

/**
 * App screens: every signed-in, kiosk and congregation screen redrawn in the
 * V2 language (one neutral ground, gold mark, ink primary, 44px targets,
 * the homepage's line drawings). Mockups with sample data, not wired to the
 * backend; the real pages are untouched. Element inventory and copy follow
 * the current pages so nothing is invented.
 */

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  ArrowRight, ArrowSquareOut, ArrowUp, BookOpen, Broadcast, CaretDown, CaretRight, ClockCounterClockwise, Copy, Eye, EyeSlash,
  FilePdf, Headphones, MagnifyingGlass, Microphone, Pause, PencilSimple, Plus, SignOut, SpeakerHigh, Trash, X,
} from '@phosphor-icons/react';
import ShemaMark from '@/components/ShemaMark';
import { Phone } from './MobileMockups';
import '@/components/app/app.css';

export const SCREENS = [
  { id: 'login', label: 'Log in' },
  { id: 'home', label: 'Dashboard' },
  { id: 'desk', label: 'Broadcast desk' },
  { id: 'kiosk', label: 'Kiosk' },
  { id: 'listen', label: 'Listener' },
  { id: 'glossary', label: 'Glossary' },
  { id: 'transcripts', label: 'Transcripts' },
  { id: 'transcript', label: 'Transcript detail' },
] as const;
export type ScreenId = (typeof SCREENS)[number]['id'];

const CHURCH = 'Hope Church';
const SLUG = 'hope-church';
const USER = 'hope';
const LISTEN_URL = `tryshema.app/listen/${SLUG}`;

/** Sample service: Korean in, English out (the direction every church runs today). */
const LINES = [
  { t: '10:31', ko: '오늘 함께 나눌 말씀은 요한복음 21장입니다.', en: "Today's passage is John chapter 21." },
  { t: '10:31', ko: '베드로는 밤새 그물을 던졌지만 아무것도 잡지 못했습니다.', en: 'Peter cast his net all night but caught nothing.' },
  { t: '10:32', ko: '그때 예수님께서 오른편에 그물을 던지라고 말씀하셨습니다.', en: 'Then Jesus told them to cast the net on the right side.' },
  { t: '10:32', ko: '여러분, 우리의 수고가 헛되다고 느낄 때가 있지 않습니까?', en: "Brothers and sisters, don't we sometimes feel our work is in vain?" },
  { t: '10:33', ko: '주님께서는 바로 그 자리에서 우리를 다시 부르십니다.', en: 'The Lord calls us again, right there in that place.' },
];
const HOLDING = '그러므로 우리는 낙심하지 말고';

// ── Shared chrome ──────────────────────────────────────────────────────────

function Brand() {
  return <span className="v2-brand"><ShemaMark /><span className="v2-brand-name">Shema</span></span>;
}

function AccountMenu() {
  const [open, setOpen] = useState(false);
  return (
    <div className="ap-acct">
      <button type="button" className="ap-avatar-btn" aria-expanded={open} onClick={() => setOpen(!open)} aria-label="Account">
        <span className="ap-avatar">{USER[0].toUpperCase()}</span>
        <CaretDown weight="bold" aria-hidden />
      </button>
      {open && (
        <div className="ap-menu" role="menu">
          <div className="ap-menu-id">
            <span className="ap-avatar ap-avatar-lg">{USER[0].toUpperCase()}</span>
            <span><strong>{USER}</strong><small>Church account</small></span>
          </div>
          <button type="button" role="menuitem"><BookOpen aria-hidden /><span>Glossary<small>Church names and terms</small></span></button>
          <button type="button" role="menuitem"><ClockCounterClockwise aria-hidden /><span>Transcripts<small>What each service said</small></span></button>
          <hr />
          <button type="button" role="menuitem" className="ap-menu-quiet"><SignOut aria-hidden /><span>Log out</span></button>
        </div>
      )}
    </div>
  );
}

function StaffBar({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="ap-bar">
      <a href="#home" className="ap-bar-brand" title="Dashboard"><Brand /></a>
      <span className="ap-bar-rule" aria-hidden />
      <span className="ap-bar-title">{title}</span>
      <span className="ap-chip">{SLUG}</span>
      <span className="ap-bar-fill" />
      {children}
      <AccountMenu />
    </header>
  );
}

function useQr(text: string, dark: string, light: string) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    QRCode.toDataURL(`https://${text}`, { width: 240, margin: 1, color: { dark, light } }).then(setSrc).catch(() => setSrc(''));
  }, [text, dark, light]);
  return src;
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; l: string; title?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ap-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" role="radio" aria-checked={value === o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)} title={o.title}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

// ── Log in ─────────────────────────────────────────────────────────────────

function Login() {
  const [show, setShow] = useState(false);
  return (
    <div className="ap-login">
      <div className="ap-login-form">
        <a href="#" className="ap-back">← Back to Shema</a>
        <Brand />
        <h1>Sign in</h1>
        <p className="ap-muted">
          Sign in to run a broadcast. Congregants don&apos;t need an account: just the listen link or the QR code at the welcome desk.
        </p>
        <form className="v2-form" onSubmit={(e) => e.preventDefault()}>
          <div className="v2-field">
            <label htmlFor="ap-user">Username</label>
            <input id="ap-user" className="v2-input" placeholder="Your church's username" autoComplete="username" />
          </div>
          <div className="v2-field">
            <label htmlFor="ap-pass">Password</label>
            <div className="ap-pass">
              <input id="ap-pass" className="v2-input" type={show ? 'text' : 'password'} placeholder="Enter your password" autoComplete="current-password" />
              <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}>
                {show ? <EyeSlash aria-hidden /> : <Eye aria-hidden />}
              </button>
            </div>
          </div>
          <button type="submit" className="v2-btn v2-btn-ink v2-form-submit">Sign in</button>
        </form>
        <p className="ap-foot-note">
          Interested in Shema for your church? <a href="#">Get in touch</a> and we&apos;ll set up a live demo service.
        </p>
      </div>
      <figure className="v2-plate ap-login-plate">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/sanctuary.svg" alt="" />
      </figure>
    </div>
  );
}

// ── Dashboard ──────────────────────────────────────────────────────────────

function Home() {
  return (
    <div className="ap-page">
      <header className="ap-bar">
        <Brand />
        <span className="ap-bar-fill" />
        <AccountMenu />
      </header>
      <main className="ap-home">
        <div className="v2-eyebrow">{CHURCH}</div>
        <h1 className="ap-h1">Welcome, {USER}.</h1>
        <p className="ap-muted">Everything you need to run a live translated service.</p>

        <a href="#desk" className="ap-action ap-action-primary">
          <span className="ap-action-icon"><Broadcast weight="bold" aria-hidden /></span>
          <span className="ap-action-text">
            <strong>Start broadcasting</strong>
            <span>Capture the sermon from a mic or soundboard and go live. The QR code for congregants is on this page.</span>
          </span>
          <ArrowRight weight="bold" className="ap-action-go" aria-hidden />
        </a>
        <a href="#kiosk" className="ap-action">
          <span className="ap-action-icon"><SpeakerHigh weight="bold" aria-hidden /></span>
          <span className="ap-action-text">
            <strong>Kiosk output</strong>
            <span>Continuous English audio out of one laptop&apos;s line-out into the church&apos;s receiver system.</span>
          </span>
          <ArrowRight weight="bold" className="ap-action-go" aria-hidden />
        </a>

        <div className="ap-home-links">
          <a href="#glossary"><BookOpen aria-hidden /><span><strong>Glossary</strong><small>Church names and terms</small></span><CaretRight aria-hidden /></a>
          <a href="#transcripts"><ClockCounterClockwise aria-hidden /><span><strong>Transcripts</strong><small>What each service said</small></span><CaretRight aria-hidden /></a>
        </div>
        <p className="ap-foot-note">Congregants never log in. Share the listen link or QR code from the broadcast desk.</p>
      </main>
    </div>
  );
}

// ── Broadcast desk ─────────────────────────────────────────────────────────

type Dir = 'ko-en' | 'en-ko' | 'zh-en';
const DIR_COLS: Record<Dir, [string, string]> = {
  'ko-en': ['한국어 · Spoken', 'English · Sent to the pews'],
  'en-ko': ['English · Spoken', '한국어 · Sent to the pews'],
  'zh-en': ['中文 · Spoken', 'English · Sent to the pews'],
};

function Meter({ live }: { live: boolean }) {
  const levels = [3, 5, 7, 9, 11, 12, 10, 8, 9, 11, 13, 10, 7, 5, 3];
  return (
    <div className="ap-meter" aria-label={live ? 'Signal good' : 'Idle'}>
      {levels.map((l, i) => <span key={i} className={live && l > 4 ? 'on' : ''} style={{ height: `${l * 6}%` }} />)}
    </div>
  );
}

function Desk() {
  const [live, setLive] = useState(true);
  const [dir, setDir] = useState<Dir>('ko-en');
  const [pace, setPace] = useState<'fast' | 'smooth'>('smooth');
  const [out, setOut] = useState<'off' | 'on'>('off');
  const [scope, setScope] = useState<'service' | 'church'>('service');
  const [diag, setDiag] = useState(false);
  const qr = useQr(LISTEN_URL, '#15171A', '#FFFFFF');
  const [srcCol, outCol] = DIR_COLS[dir];

  return (
    <div className="ap-page ap-desk">
      <header className="ap-bar">
        <a href="#home" className="ap-bar-brand" title="Dashboard"><Brand /></a>
        <span className="ap-bar-rule" aria-hidden />
        <span className="ap-bar-title">Broadcast desk</span>
        <span className="ap-chip">{SLUG}</span>
        <span className="ap-bar-fill" />
        {live && <span className="ap-pill ap-hide-sm">{pace === 'smooth' ? 'Smooth' : 'Fast'} pacing</span>}
        {live && <span className="ap-pill ap-hide-sm"><span className="ap-dot ap-dot-live" />Recording transcript</span>}
        {live && <span className="ap-timer">00:42:18</span>}
        <span className={`ap-status${live ? ' live' : ''}`}><span className="ap-dot" />{live ? 'On air' : 'Ready'}</span>
        <AccountMenu />
      </header>

      <div className="ap-desk-grid">
        <aside className="ap-rail">
          <button type="button" className={`ap-go${live ? ' live' : ''}`} onClick={() => setLive(!live)}>
            {live ? <><span className="ap-go-sq" />End broadcast</> : <><span className="ap-go-dot" />Start broadcast</>}
          </button>

          <section className="ap-panel">
            <h3>Direction {live && <small>Locked while live</small>}</h3>
            <Seg<Dir> label="Direction" value={dir} onChange={(v) => !live && setDir(v)} options={[
              { v: 'ko-en', l: '한국어 → EN', title: 'Korean sermon in, English audio out' },
              { v: 'en-ko', l: 'EN → 한국어', title: 'English sermon in, Korean audio out' },
              { v: 'zh-en', l: '中文 → EN', title: 'Mandarin sermon in, English audio out' },
            ]} />
          </section>

          <section className="ap-panel">
            <h3>Sound source</h3>
            <select className="v2-input" defaultValue="Soundboard (USB Audio CODEC)" aria-label="Input device">
              <option>System default</option>
              <option>Soundboard (USB Audio CODEC)</option>
              <option>MacBook Pro Microphone</option>
            </select>
            <div className="ap-meter-row">
              <Meter live={live} />
              <span className={live ? 'ap-ok' : 'ap-muted'}>{live ? 'Signal good' : 'Idle'}</span>
            </div>
          </section>

          <section className="ap-panel">
            <h3>Pacing <small className="ap-ok">Safe to change on air</small></h3>
            <Seg label="Pacing" value={pace} onChange={setPace} options={[{ v: 'fast', l: 'Fast' }, { v: 'smooth', l: 'Smooth' }]} />
          </section>

          <section className="ap-panel">
            <h3>Local output</h3>
            <Seg label="Local output" value={out} onChange={setOut} options={[{ v: 'off', l: 'Off' }, { v: 'on', l: 'On' }]} />
            {out === 'on' && (
              <div className="ap-out">
                <select className="v2-input" aria-label="Output device"><option>System default output</option></select>
                <label className="ap-range"><span>Volume</span><input type="range" defaultValue={80} /><span>80%</span></label>
                <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm">Test tone</button>
              </div>
            )}
          </section>

          <section className="ap-panel">
            <h3>Glossary <small>4 terms</small></h3>
            <input className="v2-input" placeholder="목장=Mokjang" aria-label="Add a term" />
            <p className="ap-hint">Enter to add. Type a name on its own to keep it unchanged, or 목장=Mokjang to set how it comes out.</p>
            <Seg label="Scope" value={scope} onChange={setScope} options={[{ v: 'service', l: 'This service' }, { v: 'church', l: 'Church' }]} />
            <ul className="ap-terms">
              {[['목장', 'Mokjang', true], ['새벽기도', 'early-morning prayer', true], ['김요셉', 'Kim Yo-seb', false], ['요한복음 21장', 'John 21', false]].map(([k, v, church]) => (
                <li key={k as string}>
                  <span lang="ko">{k}</span><span className="ap-terms-to">{v}</span>
                  {church && <span className="ap-tag">Church</span>}
                  <button type="button" aria-label={`Remove ${k}`}><X aria-hidden /></button>
                </li>
              ))}
            </ul>
          </section>

          <section className="ap-panel ap-link-panel">
            <h3>Congregation link</h3>
            <div className="ap-link">
              {qr ? <img src={qr} alt={`QR code for ${LISTEN_URL}`} /> : <span className="ap-qr-ph" />}
              <div>
                <code>{LISTEN_URL}</code>
                <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm"><Copy aria-hidden /> Copy</button>
              </div>
            </div>
          </section>
        </aside>

        <main className="ap-desk-main">
          <div className="ap-health">
            <div><span className="ap-health-k">Hearing the pastor</span><span className={`ap-health-v${live ? ' ap-ok' : ''}`}>{live ? <><span className="ap-dot ap-dot-live" />Yes</> : '—'}</span></div>
            <div><span className="ap-health-k">Delay to the pews</span><span className="ap-health-v">{live ? '2.1 seconds' : '—'}</span></div>
            <div><span className="ap-health-k">Listening now</span><span className="ap-health-v">{live ? '38 people' : '—'}</span></div>
            <div className="ap-health-actions">
              <button type="button" className="ap-link-btn" aria-pressed={diag} onClick={() => setDiag(!diag)}>Diagnostics</button>
              <a href="#listen" className="ap-link-btn">Open listener <ArrowSquareOut aria-hidden /></a>
            </div>
          </div>
          {diag && (
            <dl className="ap-diag">
              {[['Last chunk', '3.4s ago'], ['Chunker wait', '640 ms'], ['Translation', '1.21 s'], ['TTS first byte', '0.42 s'], ['TTS total', '1.9 s'], ['End-to-end', '2.1 s'], ['STT', 'connected'], ['Listeners', '38']].map(([k, v]) => (
                <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
          )}

          <div className="ap-feed">
            <div className="ap-feed-head"><span>{srcCol}</span><span>{outCol}</span></div>
            {live ? (
              <>
                {LINES.map((l, i) => {
                  const playing = i === LINES.length - 1;
                  return (
                    <div key={i} className={`ap-feed-row${playing ? ' playing' : ''}`} style={{ opacity: playing ? 1 : 0.45 + (i / LINES.length) * 0.45 }}>
                      <p lang="ko">{l.ko}</p>
                      <p>{l.en}{playing && <span className="ap-inpews"><Headphones weight="bold" aria-hidden /> In the pews</span>}</p>
                    </div>
                  );
                })}
                <div className="ap-feed-row holding">
                  <p lang="ko">{HOLDING}<span className="ap-caret" /></p>
                  <p className="ap-muted">Holding for the sentence…</p>
                </div>
              </>
            ) : (
              <p className="ap-empty">Start a broadcast to begin translating.</p>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export { Login, Home, Desk, Brand, AccountMenu, StaffBar, Seg, useQr, LINES, CHURCH, SLUG, LISTEN_URL };
