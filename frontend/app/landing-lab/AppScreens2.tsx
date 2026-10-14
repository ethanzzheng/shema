'use client';

/** App screens, part two: kiosk, listener, glossary, transcripts. See AppScreens.tsx. */

import { useState } from 'react';
import {
  ArrowLeft, ArrowRight, ArrowUp, CaretDown, CaretRight, Copy, FilePdf, MagnifyingGlass, Pause, PencilSimple, Play, Plus,
  SpeakerHigh, Trash,
} from '@phosphor-icons/react';
import { Brand, StaffBar, Seg, LINES, CHURCH } from './AppScreens';

// ── Kiosk ──────────────────────────────────────────────────────────────────

export function Kiosk() {
  const [started, setStarted] = useState(true);
  const prev = LINES[LINES.length - 2].en;
  const cur = LINES[LINES.length - 1].en;
  return (
    <div className="ap-kiosk">
      <header className="ap-kiosk-top">
        <div>
          <h1>{CHURCH}</h1>
          <span className="ap-muted">Receiver output · English</span>
        </div>
        <span className={`ap-status ap-status-lg${started ? ' live' : ''}`}><span className="ap-dot" />{started ? 'Sound is going out' : 'Output not started'}</span>
      </header>

      {started ? (
        <main className="ap-kiosk-captions" aria-live="polite">
          <p className="ap-kiosk-prev">{prev}</p>
          <p className="ap-kiosk-cur">{cur}</p>
        </main>
      ) : (
        <main className="ap-kiosk-start">
          <button type="button" className="ap-go ap-go-xl" onClick={() => setStarted(true)}><Play weight="fill" aria-hidden /> Start output</button>
          <p>
            One click unlocks continuous audio out of this laptop&apos;s headphone or line-out. Use the test tone below to
            check the church system hears it, then leave this screen open for the whole service.
          </p>
        </main>
      )}

      <footer className="ap-kiosk-ops">
        <label className="ap-range"><span>Output</span><input type="range" defaultValue={90} /><span>90%</span></label>
        <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm">Test tone</button>
        <span className="ap-ok"><span className="ap-dot ap-dot-live" />Screen stays awake</span>
        <span className="ap-muted">214 segments</span>
      </footer>
    </div>
  );
}

// ── Listener (phone) ───────────────────────────────────────────────────────

export function Listener({ state = 'live' }: { state?: 'join' | 'tap' | 'live' }) {
  const [size, setSize] = useState<'s' | 'm' | 'l'>('m');
  const [opts, setOpts] = useState(false);
  const [voice, setVoice] = useState<'basic' | 'studio' | 'captions'>('studio');
  const [catchup, setCatchup] = useState<'auto' | 'off'>('auto');
  const [playing, setPlaying] = useState(true);

  if (state === 'join') {
    return (
      <div className="ap-listen ap-join">
        <Brand />
        <h1>Join your church</h1>
        <p className="ap-muted">Enter the church code from your bulletin or the QR sign.</p>
        <input className="v2-input" placeholder="e.g. grace-church" aria-label="Church code" autoCapitalize="none" />
        <button type="button" className="v2-btn v2-btn-ink v2-form-submit">Listen <ArrowRight weight="bold" aria-hidden /></button>
        <figure className="v2-plate ap-join-plate">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/pulpit.svg" alt="" />
        </figure>
      </div>
    );
  }

  const heard = LINES.slice(0, -1);
  const now = LINES[LINES.length - 1];
  return (
    <div className={`ap-listen ap-cap-${size}`}>
      <header className="ap-listen-top">
        <h1>{CHURCH}</h1>
        <span className="ap-status live"><span className="ap-dot" />Live</span>
      </header>

      {state === 'tap' ? (
        <main className="ap-tap">
          <button type="button" className="ap-tap-btn"><SpeakerHigh weight="fill" aria-hidden /> Tap to listen</button>
          <p className="ap-muted">One tap starts the English audio. Get your headphones in first.</p>
        </main>
      ) : (
        <main className="ap-captions" aria-live="polite">
          {heard.map((l, i) => <p key={i} className="ap-cap-heard">{l.en}</p>)}
          <p className="ap-cap-now">{now.en}</p>
          <p className="ap-cap-next" lang="ko">그러므로 우리는 낙심하지 말고<span className="ap-caret" /></p>
        </main>
      )}

      {state === 'live' && (
        <footer className="ap-player">
          <div className="ap-player-row">
            <button type="button" className="ap-play" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <Pause weight="fill" aria-hidden /> : <Play weight="fill" aria-hidden />}
            </button>
            <div className="ap-player-label">
              <strong>English audio</strong>
              <span className={playing ? 'ap-ok' : 'ap-muted'}>{playing ? 'Live' : 'Paused'}</span>
            </div>
            <div className="ap-sizes" role="radiogroup" aria-label="Caption size">
              {(['s', 'm', 'l'] as const).map((s) => (
                <button key={s} type="button" role="radio" aria-checked={size === s} className={`ap-size-${s}${size === s ? ' on' : ''}`} onClick={() => setSize(s)}>A</button>
              ))}
            </div>
          </div>
          <button type="button" className="ap-opts-toggle" aria-expanded={opts} onClick={() => setOpts(!opts)}>
            {opts ? <CaretDown aria-hidden /> : <CaretRight aria-hidden />} Audio options
          </button>
          {opts && (
            <div className="ap-opts">
              <Seg label="Voice" value={voice} onChange={setVoice} options={[{ v: 'basic', l: 'Basic voice' }, { v: 'studio', l: 'Studio voice' }, { v: 'captions', l: 'Captions only' }]} />
              <div className="ap-opts-row"><span>Catch-up speed</span><Seg label="Catch-up speed" value={catchup} onChange={setCatchup} options={[{ v: 'auto', l: 'Auto' }, { v: 'off', l: 'Off' }]} /></div>
            </div>
          )}
        </footer>
      )}
    </div>
  );
}

// ── Glossary ───────────────────────────────────────────────────────────────

const CHURCH_TERMS: [string, string | null][] = [
  ['목장', 'Mokjang'], ['새벽기도', 'early-morning prayer'], ['한마음 찬양팀', 'Hanmaum Worship Team'], ['권희', null], ['수요예배', 'Wednesday service'],
];
const PAST_TERMS: [string, string, string][] = [
  ['김요셉 선교사', 'Missionary Kim Yo-seb', 'Oct 11'], ['요한복음 21장', 'John 21', 'Oct 11'], ['가을 부흥회', 'fall revival', 'Oct 4'],
];

export function Glossary() {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="ap-page">
      <StaffBar title="Glossary" />
      <main className="ap-doc">
        <section className="ap-sec">
          <div className="ap-sec-head">
            <div>
              <h2>Church terms <span className="ap-count">{CHURCH_TERMS.length}</span></h2>
              <p className="ap-muted">Permanent: in force for every service.</p>
            </div>
            <label className="ap-search"><MagnifyingGlass aria-hidden /><input placeholder="Search" aria-label="Search terms" /></label>
          </div>
          <form className="ap-add" onSubmit={(e) => e.preventDefault()}>
            <input className="v2-input" placeholder="As spoken, e.g. 목장" aria-label="As spoken" />
            <input className="v2-input" placeholder="Comes out as, e.g. Mokjang" aria-label="Comes out as" />
            <button type="submit" className="v2-btn v2-btn-ink"><Plus weight="bold" aria-hidden /> Add term</button>
          </form>
          <p className="ap-hint">Leave the second box empty to keep a name exactly as it is said.</p>
          <ul className="ap-rows">
            {CHURCH_TERMS.map(([k, v]) => (
              <li key={k}>
                {editing === k ? (
                  <form className="ap-edit" onSubmit={(e) => { e.preventDefault(); setEditing(null); }}>
                    <input className="v2-input" defaultValue={k} aria-label="As spoken" />
                    <input className="v2-input" defaultValue={v ?? ''} placeholder="blank to leave it unchanged" aria-label="Comes out as" />
                    <button type="submit" className="v2-btn v2-btn-ink v2-btn-sm">Save</button>
                    <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                ) : (
                  <>
                    <span className="ap-rows-k" lang="ko">{k}</span>
                    <ArrowRight className="ap-rows-arrow" aria-hidden />
                    {v ? <span className="ap-rows-v">{v}</span> : <span className="ap-tag">Kept as is</span>}
                    <span className="ap-rows-actions">
                      <button type="button" aria-label={`Edit ${k}`} onClick={() => setEditing(k)}><PencilSimple aria-hidden /></button>
                      <button type="button" aria-label={`Delete ${k}`} className="ap-danger"><Trash aria-hidden /></button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="ap-sec">
          <h2>From past services <span className="ap-count">{PAST_TERMS.length}</span></h2>
          <p className="ap-muted">Added for a single service. Promote one if it turns out to recur.</p>
          <ul className="ap-rows">
            {PAST_TERMS.map(([k, v, d]) => (
              <li key={k}>
                <span className="ap-rows-k" lang="ko">{k}</span>
                <ArrowRight className="ap-rows-arrow" aria-hidden />
                <span className="ap-rows-v">{v}</span>
                <span className="ap-rows-date">{d}</span>
                <span className="ap-rows-actions">
                  <button type="button" className="ap-text-btn"><ArrowUp aria-hidden /> Promote</button>
                  <button type="button" aria-label={`Delete ${k}`} className="ap-danger"><Trash aria-hidden /></button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

// ── Transcripts ────────────────────────────────────────────────────────────

const SERVICES = [
  { d: 'Sunday, October 12', y: '2026', dur: '1h 12m', n: 241, dir: 'Korean to English', live: true },
  { d: 'Wednesday, October 8', y: '2026', dur: '48m', n: 156, dir: 'Korean to English', live: false },
  { d: 'Sunday, October 5', y: '2026', dur: '1h 06m', n: 228, dir: 'Korean to English', live: false },
  { d: 'Sunday, September 28', y: '2026', dur: '1h 15m', n: 252, dir: 'English to Korean', live: false },
];

export function Transcripts() {
  return (
    <div className="ap-page">
      <StaffBar title="Transcripts" />
      <main className="ap-doc">
        <section className="ap-sec">
          <h2>Services <span className="ap-count">{SERVICES.length}</span></h2>
          <p className="ap-muted">What was said, and what Shema rendered it as.</p>
          <ul className="ap-services">
            {SERVICES.map((s) => (
              <li key={s.d}>
                <a href="#transcript">
                  <span className="ap-services-date">{s.d} <span>{s.y}</span></span>
                  <span className="ap-services-meta">
                    {s.dur} · {s.n} segments · {s.dir}
                    {s.live && <span className="ap-rec"><span className="ap-dot" />Recording</span>}
                  </span>
                  <CaretRight className="ap-services-go" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

export function TranscriptDetail() {
  const [view, setView] = useState<'both' | 'en' | 'ko'>('both');
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="ap-page">
      <StaffBar title="Transcripts" />
      <main className="ap-doc">
        <a href="#transcripts" className="ap-back"><ArrowLeft aria-hidden /> All services</a>
        <h1 className="ap-h1">Sunday, October 5 <span className="ap-muted">2026</span></h1>
        <p className="ap-muted">1h 06m · 228 segments</p>

        <div className="ap-tools">
          <Seg label="Show" value={view} onChange={setView} options={[{ v: 'both', l: 'Both' }, { v: 'en', l: 'English' }, { v: 'ko', l: '한국어' }]} />
          <label className="ap-search"><MagnifyingGlass aria-hidden /><input placeholder="Search this service" defaultValue="그물" aria-label="Search this service" /><span className="ap-matches">2 matches</span></label>
          <div className="ap-tools-actions">
            <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm"><Copy aria-hidden /> Copy</button>
            <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm"><FilePdf aria-hidden /> Save as PDF</button>
            <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm ap-danger" onClick={() => setConfirm(true)}><Trash aria-hidden /> Delete</button>
          </div>
        </div>
        <p className="ap-hint">Copy and PDF follow the language shown above.</p>

        {confirm && (
          <div className="ap-confirm" role="alertdialog" aria-label="Delete this transcript">
            <p><strong>Delete this transcript permanently?</strong> Services can carry testimonies and prayer requests, so this removes every segment for good and cannot be undone.</p>
            <div>
              <button type="button" className="v2-btn v2-btn-sm ap-btn-danger">Delete permanently</button>
              <button type="button" className="v2-btn v2-btn-ghost v2-btn-sm" onClick={() => setConfirm(false)}>Keep</button>
            </div>
          </div>
        )}

        <ol className={`ap-read ap-read-${view}`}>
          {LINES.map((l, i) => (
            <li key={i}>
              <time>{l.t}</time>
              {view !== 'en' && (
                <p lang="ko">
                  {i === 1
                    ? <><span className="ap-sel">베드로</span>는 밤새 <mark>그물</mark>을 던졌지만 아무것도 잡지 못했습니다.</>
                    : l.ko.split('그물').flatMap((part, j) => (j ? [<mark key={j}>그물</mark>, part] : [part]))}
                </p>
              )}
              {view !== 'ko' && <p>{l.en}</p>}
              {i === 1 && view !== 'en' && <button type="button" className="ap-float"><Plus weight="bold" aria-hidden /> Add “베드로” to glossary</button>}
            </li>
          ))}
        </ol>
      </main>
    </div>
  );
}
