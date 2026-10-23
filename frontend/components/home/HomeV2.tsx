'use client';

/**
 * The homepage (designed as V2 "Simple" in the landing lab, which renders this
 * same component): one plain ground, no photograph at the top. The hero's picture
 * is the product itself, the same spoken / heard card as the current homepage,
 * filling in live. The homepage's line drawings return lower down as framed
 * plates, and the page ends on a real demo-request form.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ArrowsLeftRight, Microphone, Translate, Headphones, Check, Play, QrCode, Church, EnvelopeSimple, Globe, Plus, UsersThree } from '@phosphor-icons/react';
import ShemaMark from '@/components/ShemaMark';
import { LANGS, LANG_ORDER, STEPS, type LangId } from './data';
import { LangPicker, langPhrase, useVerseCycle } from './shared';
import type { VersionProps } from './shared';
import './home.css';

const STEP_ICONS = [Microphone, Translate, Headphones];

const SETUP = [
  { tag: 'Livestream', body: 'Pulls straight from the RTMP feed you already stream.' },
  { tag: 'Line-out', body: 'Or a direct feed from the board your team already mixes.' },
  { tag: 'Receivers', body: 'English routes to the earpiece packs you already hand out.' },
  { tag: 'Web app', body: 'Or a link on their own phone and earbuds. No app store.' },
];

const SHORT: Record<LangId, string> = { zh: '中文', ko: '한국어', yue: '粵語' };

// ── Hero card ──────────────────────────────────────────────────────────────

function HeroCard({ hero, selected, onSelect, flip, setFlip }: Pick<VersionProps, 'hero' | 'selected' | 'onSelect' | 'flip' | 'setFlip'>) {
  const L = LANGS[hero.lang];
  const preview = flip ? L.reverse === 'soon' : L.status === 'soon';
  const from = flip ? 'English' : L.name;
  const to = flip ? L.name : 'English';
  const spoken = { text: flip ? hero.en : hero.src, lang: flip ? 'en' : L.htmlLang, label: flip ? 'English' : L.native };
  const heard = { text: flip ? hero.src : hero.en, lang: flip ? L.htmlLang : 'en', label: flip ? L.native : 'English' };
  return (
    <div className="v2-hero-side">
      <div className="v2-card" aria-label="Example of what a listener hears and reads">
        <div className="v2-card-top">
          <span className="v2-live">Live</span>
        </div>

        <div className="v2-card-tabs" role="tablist" aria-label="Language">
          {LANG_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={hero.lang === id}
              className={hero.lang === id ? (selected ? 'on' : 'on auto') : ''}
              onClick={() => onSelect(id)}
              lang={LANGS[id].htmlLang}
            >
              {SHORT[id]}
            </button>
          ))}
        </div>

        <div className="v2-card-dir">
          <span className="v2-card-dir-side">{from}</span>
          <button
            type="button"
            className={`v2-swap${flip ? ' flipped' : ''}`}
            onClick={() => setFlip(!flip)}
            aria-label={`Swap direction: translate ${to} into ${from} instead`}
            title="Swap direction"
          >
            <ArrowsLeftRight weight="bold" aria-hidden />
          </button>
          <span className="v2-card-dir-side v2-card-dir-to">{to}</span>
        </div>

        <div className="v2-card-label">
          <span lang={spoken.lang}>{spoken.label}</span> · Spoken
          {preview && <span className="v2-soon">Preview</span>}
        </div>
        <p className={`v2-card-src${flip ? ' is-en' : ''}`} lang={spoken.lang}>{spoken.text || '\u00a0'}</p>

        <hr className="v2-card-hr" />

        <div className="v2-card-label"><span lang={heard.lang}>{heard.label}</span> · Heard in the pews</div>
        <p className={`v2-card-en${flip ? ' is-src' : ''}`} lang={heard.lang}>{heard.text || '\u00a0'}</p>
        <span className={`v2-ref${hero.ref ? ' on' : ''}`} aria-hidden={!hero.ref}>
          <span className="v2-ref-dot" />
          {hero.ref || 'Verse'} · verse matched
        </span>
      </div>
    </div>
  );
}

// ── "Waits for the whole thought" ──────────────────────────────────────────

function useOnScreen<T extends HTMLElement>(threshold = 0.35): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, threshold]);
  return [ref, seen];
}

function PauseDemo({ lang, reduced }: { lang: LangId; reduced: boolean }) {
  const P = LANGS[lang].pause;
  const [ref, seen] = useOnScreen<HTMLDivElement>();
  // step = how many spoken pieces have arrived; pieces.length + 1 = Shema has spoken.
  const [step, setStep] = useState(0);
  const done = P.pieces.length + 1;

  useEffect(() => {
    if (reduced) { setStep(done); return; }
    if (!seen) return;
    setStep(0);
    let i = 0;
    const id = window.setInterval(() => {
      i++;
      setStep(i);
      if (i >= done) window.clearInterval(id);
    }, 900);
    return () => window.clearInterval(id);
  }, [lang, seen, reduced, done]);

  return (
    <div ref={ref} className="v2-pause">
      <div className="v2-pause-col">
        <div className="v2-pause-head">The pastor says</div>
        <p className="v2-pause-src" lang={LANGS[lang].htmlLang}>
          {P.pieces.map((p, i) => (
            <span key={`${lang}-${i}`} className={i < step ? 'in' : ''}>
              {p}
              {i < P.pieces.length - 1 && <span className="v2-pause-mark" aria-label="pause">‖</span>}
            </span>
          ))}
        </p>
      </div>
      <div className="v2-pause-col">
        <div className="v2-pause-head">Translating at every pause</div>
        <ul className="v2-pause-generic">
          {P.generic.map((g, i) => (
            <li key={`${lang}-g${i}`} className={i < step ? 'in' : ''}>{g}</li>
          ))}
        </ul>
      </div>
      <div className="v2-pause-col v2-pause-shema">
        <div className="v2-pause-head"><ShemaMark size={13} /> Shema</div>
        <p className={step >= done ? 'in' : ''}>{P.shema}</p>
        <span className="v2-pause-note">{step >= done ? 'One sentence, once it is whole.' : 'Listening for the end of the thought…'}</span>
      </div>
    </div>
  );
}

// ── Try-it-live preview ────────────────────────────────────────────────────

const TRY_LINES = [
  { ko: '하나님은 우리를 먼저 사랑하셨습니다.', en: 'God loved us first.' },
  { ko: '오늘 본문은 요한복음 15장입니다.', en: "Today's passage is John chapter 15." },
  { ko: '포도나무에 붙어 있으십시오.', en: 'Remain in the vine.' },
];
// Fixed bar heights so the waveform reads as speech, not a uniform meter.
const WAVE = Array.from({ length: 44 }, (_, i) => 0.25 + 0.75 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.45)));

/** A miniature of the live demo: a session header with a running clock, the
 *  speaker's waveform, and a Korean line followed by its English. */
function TryPreview({ reduced }: { reduced: boolean }) {
  const [line, setLine] = useState(0);
  const [secs, setSecs] = useState(14);
  useEffect(() => {
    if (reduced) return;
    const clock = setInterval(() => setSecs((s) => s + 1), 1000);
    const lines = setInterval(() => setLine((l) => (l + 1) % TRY_LINES.length), 4200);
    return () => { clearInterval(clock); clearInterval(lines); };
  }, [reduced]);
  const t = TRY_LINES[line];
  return (
    <div className="v2-try-visual" aria-hidden>
      <div className="v2-tv-bar">
        <span className="v2-tv-live">Live</span>
        <span className="v2-tv-dir">Korean <ArrowRight weight="bold" /> English</span>
        <span className="v2-tv-time">{String(Math.floor(secs / 60)).padStart(2, '0')}:{String(secs % 60).padStart(2, '0')}</span>
      </div>
      <div className="v2-tv-wave">
        {WAVE.map((h, i) => (
          <span key={i} style={{ height: `${Math.round(h * 100)}%`, animationDelay: `${-((i * 0.137) % 1.3).toFixed(2)}s`, animationDuration: `${(1 + (i % 5) * 0.18).toFixed(2)}s` }} />
        ))}
      </div>
      <div className="v2-tv-lines" key={line}>
        <p className="v2-tv-src" lang="ko">{t.ko}</p>
        <p className="v2-tv-en">{t.en}</p>
      </div>
      <div className="v2-tv-foot">
        <span className="v2-tv-mic"><Microphone weight="fill" /></span>
        <span>Your microphone</span>
        <span className="v2-tv-or">or</span>
        <span className="v2-tv-sample"><Play weight="fill" /> Sample sermon</span>
      </div>
    </div>
  );
}

// ── Demo request form ──────────────────────────────────────────────────────

type SubmitState = 'idle' | 'sending' | 'success' | 'error';

const SIZES = ['Under 100', '100 – 300', '300 – 800', '800+'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Posts a form to /api/contact. Returns the first required field left empty
 *  (or a bad email), else sends and reports the result through setState. */
function useContactSubmit(required: string[], subject: string) {
  const [state, setState] = useState<SubmitState>('idle');
  const [invalid, setInvalid] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  const onSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (state === 'sending' || state === 'success') return;
    const form = formRef.current;
    if (!form) return;
    const data = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
    setInvalid('');
    for (const name of required) {
      const v = (data[name] ?? '').trim();
      if (!v || (name === 'email' && !EMAIL_RE.test(v))) {
        setInvalid(name);
        // Radio groups come back as a list; focus their first option.
        const el = form.elements.namedItem(name);
        const target = el instanceof RadioNodeList ? (el[0] as HTMLElement | undefined) : (el as HTMLElement | null);
        target?.focus();
        return;
      }
    }
    setState('sending');
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...data, _subject: subject, _replyto: data.email }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.success) throw new Error('send failed');
      setState('success');
    } catch {
      setState('error');
    }
  }, [state, required, subject]);

  return { state, invalid, setInvalid, formRef, onSubmit };
}

const DEMO_REQUIRED = ['church', 'language', 'size', 'email'];
const LANG_REQUIRED = ['language', 'email'];

function DemoForm({ selected }: { selected: LangId | null }) {
  const { state, invalid, setInvalid, formRef, onSubmit } = useContactSubmit(DEMO_REQUIRED, 'New demo request — Shema');
  const [lang, setLang] = useState<string>(selected ? LANGS[selected].name : '');
  useEffect(() => { if (selected) setLang(LANGS[selected].name); }, [selected]);
  const clear = (name: string) => { if (invalid === name) setInvalid(''); };

  if (state === 'success') {
    return (
      <div className="v2-form-done" role="status">
        <span className="v2-form-done-icon"><Check weight="bold" aria-hidden /></span>
        <h3>Thank you. We&apos;ll be in touch.</h3>
        <p>Expect a reply within two business days, usually sooner. We&apos;ll ask for a recent sermon recording to tune it to your pastor.</p>
      </div>
    );
  }

  return (
    <form ref={formRef} className="v2-form" onSubmit={onSubmit} noValidate>
      <div className="v2-form-head">
        <span className="v2-form-step">Live demo</span>
        <span className="v2-form-free">Free · no commitment</span>
      </div>

      <div className={`v2-float${invalid === 'church' ? ' invalid' : ''}`}>
        <Church weight="duotone" aria-hidden className="v2-float-icon" />
        <input id="v2-church" name="church" placeholder=" " autoComplete="organization" onInput={() => clear('church')} />
        <label htmlFor="v2-church">Church name</label>
      </div>

      <fieldset className={`v2-choice${invalid === 'language' ? ' invalid' : ''}`}>
        <legend>Preached in</legend>
        <div className="v2-chips">
          {LANG_ORDER.map((id) => (
            <label key={id} className="v2-chip">
              <input type="radio" name="language" value={LANGS[id].name} checked={lang === LANGS[id].name} onChange={(e) => { setLang(e.target.value); clear('language'); }} />
              <span>
                <span lang={id === 'yue' ? 'zh-Hant' : id}>{SHORT[id]}</span>
                {LANGS[id].name}
                {LANGS[id].status === 'soon' && <em>early</em>}
              </span>
            </label>
          ))}
          <label className="v2-chip">
            <input type="radio" name="language" value="Other" checked={lang === 'Other'} onChange={(e) => { setLang(e.target.value); clear('language'); }} />
            <span><Plus weight="bold" aria-hidden /> Another</span>
          </label>
        </div>
        {lang === 'Other' && (
          <div className="v2-float v2-float-sm">
            <input id="v2-language-other" name="languageOther" placeholder=" " autoFocus />
            <label htmlFor="v2-language-other">Which language?</label>
          </div>
        )}
      </fieldset>

      <fieldset className="v2-choice">
        <legend><UsersThree weight="bold" aria-hidden /> Congregation size</legend>
        <div className="v2-seg">
          {SIZES.map((s, i) => (
            <label key={s}>
              <input type="radio" name="size" value={s} defaultChecked={i === 0} />
              <span>{s}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className={`v2-float${invalid === 'email' ? ' invalid' : ''}`}>
        <EnvelopeSimple weight="duotone" aria-hidden className="v2-float-icon" />
        <input id="v2-email" name="email" type="email" placeholder=" " autoComplete="email" onInput={() => clear('email')} />
        <label htmlFor="v2-email">Your email</label>
      </div>

      <button type="submit" className="v2-btn v2-btn-ink v2-form-submit" disabled={state === 'sending'}>
        {state === 'sending' ? <><span className="v2-spin" aria-hidden /> Sending…</> : <>Request a demo <ArrowRight weight="bold" aria-hidden className="v2-arrow" /></>}
      </button>
      <p className="v2-form-note" role="status">
        {state === 'error'
          ? <>That didn&apos;t send. Email us at <a href="mailto:shematranslate@gmail.com?subject=Demo%20request">shematranslate@gmail.com</a> instead.</>
          : invalid === 'email'
            ? 'Please enter a valid email address.'
            : invalid
              ? 'Please fill in the highlighted field.'
              : 'We reply within two business days.'}
      </p>
    </form>
  );
}

// ── Language request ───────────────────────────────────────────────────────

const ASKED_FOR = ['Spanish', 'Vietnamese', 'Tagalog', 'Portuguese', 'Japanese', 'Russian'];

function LanguageForm() {
  const { state, invalid, setInvalid, formRef, onSubmit } = useContactSubmit(LANG_REQUIRED, 'New language request — Shema');
  const [language, setLanguage] = useState('');

  if (state === 'success') {
    return (
      <div className="v2-langdone" role="status">
        <span className="v2-form-done-icon"><Check weight="bold" aria-hidden /></span>
        <p><strong>{language || 'Your language'} is on our list.</strong> We&apos;ll email you when it&apos;s ready.</p>
      </div>
    );
  }

  return (
    <form ref={formRef} className="v2-langform" onSubmit={onSubmit} noValidate>
      <div className="v2-capsule">
        <div className={`v2-capsule-field${invalid === 'language' ? ' invalid' : ''}`}>
          <Globe weight="duotone" aria-hidden />
          <label className="v2-sr" htmlFor="v2-lang-req">Your language</label>
          <input id="v2-lang-req" name="language" placeholder="Your language" value={language}
            onChange={(e) => { setLanguage(e.target.value); if (invalid === 'language') setInvalid(''); }} />
        </div>
        <div className={`v2-capsule-field${invalid === 'email' ? ' invalid' : ''}`}>
          <EnvelopeSimple weight="duotone" aria-hidden />
          <label className="v2-sr" htmlFor="v2-lang-email">Your email</label>
          <input id="v2-lang-email" name="email" type="email" placeholder="you@church.org" autoComplete="email"
            onInput={() => { if (invalid === 'email') setInvalid(''); }} />
        </div>
        <button type="submit" className="v2-btn v2-btn-ink v2-capsule-btn" disabled={state === 'sending'}>
          {state === 'sending' ? <><span className="v2-spin" aria-hidden /> Sending</> : <>Request it <ArrowRight weight="bold" aria-hidden className="v2-arrow" /></>}
        </button>
      </div>
      <div className="v2-asked">
        <span>Often asked for</span>
        {ASKED_FOR.map((l) => (
          <button key={l} type="button" className={`v2-asked-chip${language === l ? ' on' : ''}`}
            onClick={() => { setLanguage(l); if (invalid === 'language') setInvalid(''); }}>
            {l}
          </button>
        ))}
      </div>
      <p className="v2-form-note" role="status">
        {state === 'error'
          ? <>That didn&apos;t send. Email <a href="mailto:shematranslate@gmail.com?subject=Language%20request">shematranslate@gmail.com</a> instead.</>
          : invalid === 'email' ? 'Please enter a valid email address.' : invalid ? 'Please tell us the language.' : ''}
      </p>
    </form>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function HomeV2({ selected, onSelect, hero, holdRef, reduced, flip, setFlip }: VersionProps) {
  const { verse, lit, shownFull } = useVerseCycle(selected, reduced);
  const pauseLang: LangId = selected ?? 'zh';
  const challenges = selected
    ? LANGS[selected].challenges.map((c) => ({ ...c, lang: selected }))
    : LANG_ORDER.map((id) => ({ ...LANGS[id].challenges[0], lang: id }));
  const glossary = selected
    ? LANGS[selected].glossary.map((g) => ({ ...g, lang: selected }))
    : LANG_ORDER.flatMap((id) => LANGS[id].glossary.slice(0, 2).map((g) => ({ ...g, lang: id })));

  return (
    <div className="v2">
      <nav className="v2-nav">
        <a href="#top" className="v2-brand"><ShemaMark /><span className="v2-brand-name">Shema</span></a>
        <div className="v2-nav-links">
          <a href="#why" className="v2-hide-sm">Why Shema</a>
          <a href="#how" className="v2-hide-sm">How it works</a>
          <Link href="/login" className="v2-hide-sm">Log in</Link>
          <a href="/demo" className="v2-hide-xs">Try it live</a>
          <a href="#demo" className="v2-btn v2-btn-ink v2-btn-sm">Request a demo</a>
        </div>
      </nav>

      <header id="top" className="v2-hero">
        <div className="v2-hero-copy">
          {/* Flipping the card flips the promise: the picker always names the
              language that is NOT English, on whichever side it sits. */}
          <h1>
            {flip ? (
              <>
                <span className="v2-h1-line v2-h1-quiet">Preached in English.</span>
                <span className="v2-h1-line">
                  Heard in{' '}
                  <LangPicker shown={hero.lang} selected={selected} onSelect={onSelect} holdRef={holdRef} className="v2-lp" menuClassName="v2-menu" />
                  .
                </span>
              </>
            ) : (
              <>
                <span className="v2-h1-line">
                  Preached in{' '}
                  <LangPicker shown={hero.lang} selected={selected} onSelect={onSelect} holdRef={holdRef} className="v2-lp" menuClassName="v2-menu" />
                  .
                </span>
                <span className="v2-h1-line v2-h1-quiet">Heard in English.</span>
              </>
            )}
          </h1>
          <p className="v2-lead">
            {flip
              ? <>Live sermon translation from English into a natural {LANGS[hero.lang].name} voice and captions, on every listener&apos;s own phone, about two seconds behind the pastor.</>
              : <>Live sermon translation into a natural English voice and captions, on every listener&apos;s own phone, about two seconds behind the pastor. And back the other way, for English sermons.</>}
          </p>
          <div className="v2-ctas">
            <a href="#demo" className="v2-btn v2-btn-ink">Request a demo <ArrowRight weight="bold" aria-hidden /></a>
            <a href="/demo" className="v2-btn v2-btn-ghost"><Microphone weight="bold" aria-hidden /> Try it live</a>
          </div>
          <p className="v2-cta-note">Try it on your own voice in the browser. Free, no sign‑up.</p>
        </div>
        <HeroCard hero={hero} selected={selected} onSelect={onSelect} flip={flip} setFlip={setFlip} />
      </header>

      <div className="v2-facts" aria-label="At a glance">
        <span>No app to install</span>
        <span>Scan a QR code, listen on earbuds</span>
        <span>Uses your current sound system</span>
        <span>Quotes Scripture, never guesses it</span>
      </div>

      <section className="v2-section v2-try-wrap" id="try">
        <a href="/demo" className="v2-try" aria-label="Open the live demo">
          <div className="v2-try-copy">
            <div className="v2-eyebrow">Try it live</div>
            <h2 className="v2-h2">Hear it on your own voice, right now.</h2>
            <ol className="v2-try-steps">
              <li><Microphone weight="bold" aria-hidden /><span>Speak Korean or English into your microphone, or play our sample sermon.</span></li>
              <li><Translate weight="bold" aria-hidden /><span>Watch the translation appear as you talk, on the real pipeline.</span></li>
              <li><QrCode weight="bold" aria-hidden /><span>Sign in to hear the voice and open it on your phone, the way a congregation does.</span></li>
            </ol>
            <span className="v2-btn v2-btn-ink v2-try-btn">Start the live demo <ArrowRight weight="bold" aria-hidden /></span>
            <p className="v2-try-note">
              Captions are free without an account.
              {selected === 'zh' || selected === 'yue'
                ? ` The live demo runs Korean ⇄ English today; ${LANGS[selected].name} is coming to it.`
                : ' The live demo runs Korean ⇄ English today.'}
            </p>
          </div>
          <TryPreview reduced={reduced} />
        </a>
      </section>

      <section className="v2-section" id="why">
        <div className="v2-eyebrow">Why Shema</div>
        <h2 className="v2-h2">Where generic translation breaks.</h2>
        <div className="v2-rows">
          {challenges.map((c) => (
            <div key={c.title} className="v2-row">
              <div className="v2-row-sample">
                <span className="v2-row-src" lang={LANGS[c.lang].htmlLang}>{c.sample}</span>
                <span className="v2-row-miss">Generic tool: {c.miss}</span>
              </div>
              <div className="v2-row-text">
                {!selected && <span className="v2-row-lang">{LANGS[c.lang].name}</span>}
                <h3>{c.title}</h3>
                <p>{c.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="v2-section v2-section-tight">
        <div className="v2-split-head">
          <h2 className="v2-h2">It waits for the whole thought.</h2>
          <p className="v2-muted">
            Preachers pause mid-sentence. A tool that translates at every pause speaks in pieces.
            Shema listens until the sentence is whole, then speaks it once.
          </p>
        </div>
        <PauseDemo lang={pauseLang} reduced={reduced} />
      </section>

      <section className="v2-band">
        <div className="v2-band-inner">
          <div className="v2-eyebrow">Scripture</div>
          <h2 className="v2-h2">It quotes the verse. It doesn&apos;t guess it.</h2>
          <p className="v2-band-cite" lang={LANGS[verse.lang].htmlLang} aria-label={`${verse.spoken.join(' ')}, spoken in ${LANGS[verse.lang].name}`}>
            {verse.spoken.map((t, i) => (
              <span key={`${verse.lang}-${verse.ref}-${i}`} className={i < lit ? 'lit' : ''}>{t}</span>
            ))}
          </p>
          <p className={`v2-band-verse${shownFull ? ' on' : ''}`}>
            <span className="v2-band-ref">{verse.ref}</span> {verse.text}
          </p>
        </div>
      </section>

      <section className="v2-section v2-how" id="how">
        <div className="v2-how-art">
          <div className="v2-eyebrow">How it works</div>
          <h2 className="v2-h2">Nothing changes at the pulpit.</h2>
          <p className="v2-how-sub">Everything changes in the pews.</p>
          <figure className="v2-plate v2-plate-listener">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/pulpit.svg" alt="Line drawing of a listener wearing an earpiece" />
          </figure>
          <p className="v2-plate-cap"><Check weight="bold" aria-hidden /> Plays through their own phone or your receivers</p>
        </div>
        <ol className="v2-steps">
          {STEPS.map((s, i) => {
            const Icon = STEP_ICONS[i];
            return (
              <li key={s.title}>
                <span className="v2-step-n">0{i + 1}</span>
                <div>
                  <h3><Icon className="v2-step-icon" weight="regular" aria-hidden />{s.title}</h3>
                  <p>{s.body}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="v2-section v2-section-tight">
        <h2 className="v2-h2">Works with the setup you already run.</h2>
        <p className="v2-muted v2-gap">
          No new sound system and no hardware to buy. Shema takes the audio you already send out,
          and the English comes back on whatever your congregation already listens through.
        </p>
        <div className="v2-setup">
          {SETUP.map((c) => (
            <div key={c.tag} className="v2-setup-card">
              <div className="v2-setup-tag">{c.tag}</div>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="v2-section v2-gloss">
        <div>
          <h2 className="v2-h2">It speaks your church&apos;s vocabulary.</h2>
          <p className="v2-muted v2-gap">Add your church&apos;s own words once: ministries, hymns, names. Shema uses them every Sunday.</p>
        </div>
        <ul className="v2-vocab">
          {glossary.map((g) => (
            <li key={g.src}>
              <span className="v2-vocab-src" lang={LANGS[g.lang].htmlLang}>{g.src}</span>
              <ArrowRight aria-hidden className="v2-vocab-arrow" />
              <span className="v2-vocab-en">{g.en}</span>
              <span className="v2-vocab-lang">{LANGS[g.lang].name}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="v2-quote">
        <ShemaMark size={28} />
        <p>Shema doesn&apos;t replace the pastor&apos;s voice. It carries it to everyone in the room.</p>
      </section>

      <section className="v2-demo" id="demo">
        <div className="v2-demo-inner">
          <div className="v2-demo-copy">
            <h2 className="v2-h2">Bring it to your church.</h2>
            <p className="v2-muted">
              A human interpreter costs $200–500 a Sunday and covers one language. Tell us about your
              congregation and we&apos;ll set up a live demo service in {langPhrase(selected, "your pastor's language")}.
              No cost, no commitment.
              {selected === 'yue' && ' Cantonese is in development; join early and help us tune it.'}
            </p>
            <ul className="v2-demo-list">
              <li>We tune it to your pastor on a recent sermon recording first.</li>
              <li>Works with the microphone and sound system you already have.</li>
              <li>A real person walks your team through the first Sunday.</li>
            </ul>
            <p className="v2-demo-mail">
              Prefer email? <a href="mailto:shematranslate@gmail.com">shematranslate@gmail.com</a>
            </p>
          </div>
          <div className="v2-form-card">
            <DemoForm selected={selected} />
          </div>
        </div>
      </section>

      <section className="v2-section">
        <div className="v2-langs-panel v2-langs">
        <div>
          <h2 className="v2-h2">Preaching in another language?</h2>
          <p className="v2-muted v2-gap">
            Each new language is tuned to how preaching actually sounds in it. Tell us yours and we&apos;ll let you know when it&apos;s ready.
          </p>
        </div>
        <LanguageForm />
        </div>
      </section>

      <section className="v2-section v2-closing">
        <figure className="v2-plate v2-plate-sanctuary">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/sanctuary.svg" alt="Line drawing of a sanctuary: nave, arches, altar rail, and a gold cross" />
        </figure>
      </section>

      <footer className="v2-foot">
        <div className="v2-foot-brand">
          <span className="v2-brand"><ShemaMark /><span className="v2-brand-name">Shema</span></span>
          <span className="v2-foot-he" lang="he">שְׁמַע</span>
          <span className="v2-foot-small">Made for the multilingual sanctuary</span>
        </div>
        <div className="v2-foot-col">
          <div className="v2-foot-head">Product</div>
          <a href="#why">Why Shema</a>
          <a href="#how">How it works</a>
          <a href="/demo">Try it live</a>
          <a href="#demo">Request a demo</a>
          <Link href="/login">Staff log in</Link>
        </div>
        <div className="v2-foot-col">
          <div className="v2-foot-head">Contact</div>
          <a href="mailto:shematranslate@gmail.com">shematranslate@gmail.com</a>
          <span className="v2-foot-small">© 2026 Shema</span>
        </div>
      </footer>
    </div>
  );
}
