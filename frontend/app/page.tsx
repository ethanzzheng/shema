'use client';

/**
 * Marketing homepage — 2026 redesign (design_handoff_shema_redesign).
 * Parchment ground, Instrument Serif display, night demo panes. Fully fluid
 * (auto-fit grids + clamp type); all motion is gated on prefers-reduced-motion
 * and every demo timer is cleaned up on unmount. Forms POST /api/contact
 * (Next rewrite → contact Worker), same contract as the old static page.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

// ── Demo data (from the design prototype) ──────────────────────────────────

const TYPE_PAIRS = [
  { ko: '하나님은 지금도 일하고 계십니다.', en: 'God is still at work, even now.', ref: '' },
  { ko: '요한복음 삼장 십육절 말씀입니다.', en: 'This is from John, chapter three, verse sixteen.', ref: 'JOHN 3:16 · MATCHED' },
  { ko: '두려워하지 마십시오. 내가 너와 함께 함이라.', en: 'Do not be afraid. I am with you.', ref: 'ISAIAH 41:10 · MATCHED' },
  { ko: '그분의 은혜가 우리 가운데 있습니다.', en: 'His grace is here among us.', ref: '' },
  { ko: '여호와는 나의 목자시니 내게 부족함이 없으리로다.', en: 'The Lord is my shepherd; I shall not want.', ref: 'PSALM 23:1 · MATCHED' },
];

const MARQUEE_ITEMS = [
  ['은혜', 'grace'],
  ['역사하다', 'God is at work'],
  ['찬송가 405장', 'Hymn no. 405'],
  ['삼장 오절', 'chapter 3, verse 5'],
  ['성령', 'the Holy Spirit'],
  ['아멘', 'Amen'],
];

const PROBLEM_CARDS = [
  {
    mono: '요한복음 3:16 → a guess',
    title: 'Scripture gets re-translated from scratch.',
    body: 'The congregation hears a paraphrase of a paraphrase, not the verse printed in their own Bible.',
  },
  {
    mono: '…하지 → cut short',
    title: 'The sentence gets cut in half.',
    body: 'Korean puts the verb at the end. Generic tools translate before the meaning has arrived.',
  },
  {
    mono: '역사하다 → "make history"',
    title: 'The theology flattens out.',
    body: 'A phrase that means "God is at work" comes back literal, and the meaning is gone.',
  },
];

const VERSES = [
  { toks: ['요한복음', '삼장', '십육절'], ref: 'John 3:16 · matched', text: '"For God so loved the world, that he gave his one and only Son…"' },
  { toks: ['빌립보서', '사장', '십삼절'], ref: 'Philippians 4:13 · matched', text: '"I can do all things through him who gives me strength."' },
  { toks: ['시편', '이십삼편', '일절'], ref: 'Psalm 23:1 · matched', text: '"The Lord is my shepherd; I shall not want."' },
  { toks: ['이사야', '사십일장', '십절'], ref: 'Isaiah 41:10 · matched', text: '"Fear not, for I am with you; be not dismayed, for I am your God…"' },
  { toks: ['신명기', '육장', '사절'], ref: 'Deuteronomy 6:4 · matched', text: '"Hear, O Israel: The Lord our God, the Lord is one."' },
];

const VOCAB_ROWS = [
  { kr: '역사하다', en: 'God is at work', dir: 'KO → EN' },
  { kr: '찬송가 405장', en: 'Hymn no. 405', dir: 'KO → EN' },
  { kr: '내어드리다', en: 'to surrender', dir: 'EN → KO' },
  { kr: '성령', en: 'the Holy Spirit', dir: 'EN → KO' },
];

const CONTEXT_LINES = [
  'His grace is here among us.',
  'The Lord is my shepherd; I shall not want.',
  'Do not be afraid, for I am with you.',
  'God is still at work, even now.',
];

const STEPS = [
  { n: '01', title: 'The pastor preaches.', body: 'No new lapel mic, no pausing for an interpreter, nothing different from a normal Sunday.' },
  { n: '02', title: 'Shema listens and translates.', body: 'The sermon is recognized, translated, and spoken back in a natural voice in about two seconds: Korean into English, or English into Korean.' },
  { n: '03', title: 'The congregation listens.', body: 'Earbuds, the receiver packs from the welcome desk, or a link on their phone, with the transcript to read along.' },
];

const SETUP_CARDS = [
  { tag: 'RTMP', body: 'Pulls straight from your livestream feed.' },
  { tag: 'LINE-OUT', body: 'Or a direct feed from the board your team already mixes.' },
  { tag: 'RECEIVERS', body: 'English routes to the earpiece packs you already hand out.' },
  { tag: 'WEB APP', body: 'Or a link on their phone, their own earbuds. No app store.' },
];

// ── Small helpers ──────────────────────────────────────────────────────────

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

/** Timer registry: everything scheduled here dies with the component. */
function useTimers() {
  const ids = useRef<{ t: ReturnType<typeof setTimeout>[]; i: ReturnType<typeof setInterval>[] }>({ t: [], i: [] });
  useEffect(() => {
    const cur = ids.current;
    return () => {
      cur.t.forEach(clearTimeout);
      cur.i.forEach(clearInterval);
    };
  }, []);
  return {
    after: (ms: number, fn: () => void) => { ids.current.t.push(setTimeout(fn, ms)); },
    every: (ms: number, fn: () => void) => {
      const id = setInterval(fn, ms);
      ids.current.i.push(id);
      return id;
    },
  };
}

/** One-shot visibility trigger (starts a demo when it scrolls into view). */
function useOnScreen(threshold = 0.2): [React.RefObject<HTMLDivElement>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) setSeen(true); }),
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold, seen]);
  return [ref, seen];
}

// ── Cross glyphs ───────────────────────────────────────────────────────────

function CrossGlyph({ size = 20, stroke = 'var(--gold-ink)' }: { size?: number; stroke?: string }) {
  return (
    <svg width={size * 0.75} height={size} viewBox="0 0 24 32" fill="none" aria-hidden>
      <line x1="12" y1="1" x2="12" y2="31" stroke={stroke} strokeWidth="1.7" strokeLinecap="round" />
      <line x1="3" y1="10" x2="21" y2="10" stroke={stroke} strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/** Hero watermark: draws itself in on mount; wrapper gets the parallax. */
function CrossWatermark({ reduced }: { reduced: boolean }) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const line = (drawnLen: number) => ({
    strokeDasharray: drawnLen,
    strokeDashoffset: reduced || drawn ? 0 : drawnLen,
  });
  return (
    <svg width={Math.min(520, 420)} height={560} viewBox="0 0 24 32" fill="none" aria-hidden style={{ overflow: 'visible' }}>
      <line x1="12" y1="1" x2="12" y2="31" stroke="var(--gold-ink)" strokeWidth="1.5" strokeLinecap="round"
        style={{ ...line(30), transition: 'stroke-dashoffset 1.2s cubic-bezier(.4,0,.2,1)' }} />
      <line x1="3" y1="10" x2="21" y2="10" stroke="var(--gold-ink)" strokeWidth="1.5" strokeLinecap="round"
        style={{ ...line(18), transition: 'stroke-dashoffset 1.2s cubic-bezier(.4,0,.2,1) 0.35s' }} />
    </svg>
  );
}

// ── Hero demo pane (direction toggle + typewriter) ─────────────────────────

type Dir = 'ko' | 'en';

function HeroDemo({ reduced }: { reduced: boolean }) {
  const [dir, setDir] = useState<Dir>('ko');
  const [src, setSrc] = useState('');
  const [out, setOut] = useState('');
  const [tag, setTag] = useState('');
  const cycleRef = useRef(0);

  useEffect(() => {
    const run = ++cycleRef.current;
    const alive = () => cycleRef.current === run;
    if (reduced) {
      const p = TYPE_PAIRS[0];
      setSrc(dir === 'ko' ? p.ko : p.en);
      setOut(dir === 'ko' ? p.en : p.ko);
      setTag(p.ref);
      return;
    }
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const type = async (text: string, speed: number, set: (s: string) => void) => {
      for (let i = 1; i <= text.length; i++) {
        if (!alive()) return;
        set(text.slice(0, i) + '▍');
        await sleep(speed);
      }
      if (alive()) set(text);
    };
    (async () => {
      await sleep(120);
      let idx = 0;
      while (alive()) {
        const p = TYPE_PAIRS[idx % TYPE_PAIRS.length];
        idx++;
        const srcText = dir === 'ko' ? p.ko : p.en;
        const outText = dir === 'ko' ? p.en : p.ko;
        setSrc(''); setOut(''); setTag('');
        await type(srcText, dir === 'ko' ? 58 : 30, setSrc);
        if (!alive()) return;
        await sleep(340);
        await type(outText, dir === 'ko' ? 30 : 58, setOut);
        if (!alive()) return;
        if (p.ref) setTag(p.ref);
        await sleep(2400);
      }
    })();
    return () => { cycleRef.current++; };
  }, [dir, reduced]);

  const srcKorean = dir === 'ko';
  return (
    <div className="mk-demo rv">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="dot dot-pulse" style={{ color: 'var(--sage)', width: 8, height: 8 }} />
          <span className="mk-micro" style={{ color: 'var(--sage)' }}>Live</span>
        </span>
        <span className="mk-micro" style={{ color: 'rgba(244,241,234,0.42)' }}>2.3s</span>
      </div>

      <div className="mk-demo-toggle" role="tablist" aria-label="Translation direction">
        <button className={dir === 'ko' ? 'active' : ''} onClick={() => setDir('ko')} role="tab" aria-selected={dir === 'ko'}>
          한국어 → English
        </button>
        <button className={dir === 'en' ? 'active' : ''} onClick={() => setDir('en')} role="tab" aria-selected={dir === 'en'}>
          English → 한국어
        </button>
      </div>

      <div className="mk-demo-label">{srcKorean ? '한국어 · Spoken' : 'English · Spoken'}</div>
      <p
        className={`mk-demo-src ${srcKorean ? 'serif-kr' : 'serif-en'}`}
        lang={srcKorean ? 'ko' : 'en'}
        style={{ fontSize: srcKorean ? 'clamp(17px, 1.7vw, 21px)' : 'clamp(16px, 1.6vw, 19px)', color: 'rgba(244,241,234,0.9)' }}
      >
        {src}
      </p>

      <hr className="mk-demo-hr" />

      <div className="mk-demo-label">{srcKorean ? 'English · Heard in the pews' : '한국어 · Heard in the pews'}</div>
      <p
        className={`mk-demo-out ${srcKorean ? 'serif-en' : 'serif-kr'}`}
        lang={srcKorean ? 'en' : 'ko'}
        style={{ fontSize: srcKorean ? 'clamp(24px, 2.6vw, 32px)' : 'clamp(20px, 2.1vw, 26px)', color: 'var(--gold)' }}
      >
        {out}
      </p>
      <div className="mk-chip" style={{ opacity: tag ? 1 : 0 }} aria-hidden={!tag}>
        <span className="dot" style={{ width: 5, height: 5 }} />
        {tag || 'VERSE MATCHED'}
      </div>
    </div>
  );
}

// ── Capability demos ───────────────────────────────────────────────────────

function VerseMatcherDemo({ reduced }: { reduced: boolean }) {
  const [wrapRef, seen] = useOnScreen(0.2);
  const [verse, setVerse] = useState(VERSES[0]);
  const [lit, setLit] = useState<number>(reduced ? 3 : 0);
  const [shown, setShown] = useState(reduced);
  const timers = useTimers();

  useEffect(() => {
    if (!seen || reduced) return;
    let vi = 0;
    let disposed = false;
    const play = () => {
      if (disposed) return;
      const v = VERSES[vi % VERSES.length];
      vi++;
      setVerse(v);
      setLit(0);
      setShown(false);
      v.toks.forEach((_, i) => timers.after(380 + i * 520, () => setLit((n) => Math.max(n, i + 1))));
      timers.after(380 + (v.toks.length - 1) * 520 + 220, () => setShown(true));
      timers.after(380 + (v.toks.length - 1) * 520 + 220 + 4600, () => {
        setLit(0);
        setShown(false);
        timers.after(700, play);
      });
    };
    play();
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, reduced]);

  return (
    <div ref={wrapRef} className="mk-verse-demo rv">
      <div className="mk-micro" style={{ color: 'var(--text-4)', marginBottom: 14 }}>Heard on the mic</div>
      <div>
        {verse.toks.map((t, i) => (
          <span key={`${verse.ref}-${i}`} lang="ko" className={`mk-verse-token${(reduced || i < lit) ? ' lit' : ''}`}>{t}</span>
        ))}
      </div>
      <div className={`mk-verse-out${(reduced || shown) ? ' shown' : ''}`}>
        <div className="mk-tag" style={{ color: 'var(--gold-ink)', marginBottom: 6 }}>{verse.ref}</div>
        <p className="serif-en" style={{ fontSize: 'clamp(18px, 1.9vw, 23px)', lineHeight: 1.45, color: 'var(--ink)' }}>{verse.text}</p>
      </div>
    </div>
  );
}

const WAVE_BAR_COUNT = 46;

function WaveformDemo({ reduced }: { reduced: boolean }) {
  const [wrapRef, seen] = useOnScreen(0.2);
  const [released, setReleased] = useState(reduced);
  // Rounded so SSR and client hydrate to identical style strings.
  const [heights, setHeights] = useState<number[]>(() =>
    Array.from({ length: WAVE_BAR_COUNT }, (_, i) => Math.round(10 + Math.abs(Math.sin(i * 0.42)) * 78)),
  );
  const timers = useTimers();

  useEffect(() => {
    if (!seen || reduced) return;
    const t0 = Date.now();
    timers.every(160, () => {
      const t = Date.now() - t0;
      setHeights(Array.from({ length: WAVE_BAR_COUNT }, (_, i) => Math.round(10 + Math.abs(Math.sin(t / 320 + i * 0.42)) * 78)));
    });
    let disposed = false;
    const cycle = (holding: boolean) => {
      if (disposed) return;
      setReleased(!holding);
      timers.after(holding ? 2600 : 2800, () => cycle(!holding));
    };
    cycle(true);
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, reduced]);

  return (
    <div ref={wrapRef} className="mk-wave-demo rv">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <span lang="ko" className="serif-kr" style={{ fontSize: 17, color: 'rgba(244,241,234,0.9)' }}>하나님이 일하시고 …</span>
        <span className={`mk-hold-chip${released ? ' released' : ''}`}>
          <span className="dot dot-pulse" style={{ width: 5, height: 5 }} />
          {released ? 'Released' : 'Holding'}
        </span>
      </div>
      <div className={`mk-wave-bars${released ? ' released' : ''}`} aria-hidden>
        {heights.map((h, i) => (
          <span key={i} style={{ height: `${h}%` }} />
        ))}
      </div>
      <p className="serif-en" style={{ fontSize: 'clamp(19px, 2vw, 24px)', color: released ? 'var(--cream)' : 'rgba(244,241,234,0.42)', minHeight: '1.5em' }}>
        {released ? 'God is at work among us.' : '…'}
      </p>
    </div>
  );
}

function VocabRows({ reduced }: { reduced: boolean }) {
  const [wrapRef, seen] = useOnScreen(0.2);
  const [litCount, setLitCount] = useState(reduced ? VOCAB_ROWS.length : 0);
  const timers = useTimers();

  useEffect(() => {
    if (!seen || reduced) return;
    VOCAB_ROWS.forEach((_, i) => timers.after(i * 220, () => setLitCount((n) => Math.max(n, i + 1))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, reduced]);

  return (
    <div ref={wrapRef} style={{ marginTop: 26 }}>
      {VOCAB_ROWS.map((r, i) => (
        <div key={r.kr} className={`mk-vocab-row${(reduced || i < litCount) ? ' on' : ''}`}>
          <span lang="ko" className="mk-vocab-kr">{r.kr}</span>
          <span className="mk-vocab-arrow" aria-hidden>{r.dir === 'KO → EN' ? '→' : '←'}</span>
          <span className="mk-vocab-en">{r.en}</span>
          <span className="mk-tag mk-vocab-tag">{r.dir}</span>
        </div>
      ))}
    </div>
  );
}

function ContextDemo({ reduced }: { reduced: boolean }) {
  const [wrapRef, seen] = useOnScreen(0.2);
  const [filled, setFilled] = useState(reduced ? 8 : 0);
  const [verified, setVerified] = useState(reduced);
  const [lineIdx, setLineIdx] = useState(0);
  const [lineVisible, setLineVisible] = useState(true);
  const timers = useTimers();

  useEffect(() => {
    if (!seen || reduced) return;
    for (let i = 0; i < 8; i++) timers.after(i * 110, () => setFilled((n) => Math.max(n, i + 1)));
    timers.after(8 * 110 + 240, () => setVerified(true));
    timers.every(3600, () => {
      setLineVisible(false);
      timers.after(400, () => {
        setLineIdx((n) => (n + 1) % CONTEXT_LINES.length);
        setLineVisible(true);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, reduced]);

  return (
    <div ref={wrapRef} className="mk-context-card rv">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <span className="mk-micro" style={{ color: 'var(--text-4)' }}>Context · last 8 segments</span>
        <span className={`mk-verified${verified ? ' on' : ''}`}>
          <span className="dot" style={{ width: 5, height: 5 }} />
          Verified
        </span>
      </div>
      <div className="mk-context-segs" aria-hidden>
        {Array.from({ length: 8 }, (_, i) => (
          <span key={i} className={i < filled ? 'on' : ''} />
        ))}
      </div>
      <p className="mk-context-line" style={{ opacity: verified ? (lineVisible ? 1 : 0) : 0 }}>
        {CONTEXT_LINES[lineIdx]}
      </p>
    </div>
  );
}

// ── Forms ──────────────────────────────────────────────────────────────────

type SubmitState = 'idle' | 'sending' | 'success' | 'error';

function useContactSubmit(subject: string) {
  const [state, setState] = useState<SubmitState>('idle');
  const submit = useCallback(
    async (fields: Record<string, string>, markInvalid: (name: string) => void): Promise<void> => {
      if (state === 'sending' || state === 'success') return;
      for (const [name, value] of Object.entries(fields)) {
        if (!value.trim()) { markInvalid(name); return; }
        if (name === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { markInvalid(name); return; }
      }
      setState('sending');
      try {
        const res = await fetch('/api/contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ ...fields, _subject: subject, _replyto: fields.email }),
        });
        const body = await res.json().catch(() => ({}));
        if (body.success) {
          setState('success');
        } else {
          throw new Error('send failed');
        }
      } catch {
        setState('error');
        window.location.href = `mailto:shematranslate@gmail.com?subject=${encodeURIComponent(subject)}`;
      }
    },
    [state, subject],
  );
  return { state, submit };
}

function PilotForm() {
  const { state, submit } = useContactSubmit('New demo request — Shema');
  const [invalid, setInvalid] = useState('');
  const churchRef = useRef<HTMLInputElement>(null);
  const sizeRef = useRef<HTMLSelectElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setInvalid('');
    submit(
      {
        church: churchRef.current?.value ?? '',
        size: sizeRef.current?.value ?? '',
        email: emailRef.current?.value ?? '',
      },
      (name) => {
        setInvalid(name);
        ({ church: churchRef, size: sizeRef, email: emailRef } as const)[name as 'church' | 'size' | 'email']?.current?.focus();
      },
    );
  };

  return (
    <form onSubmit={onSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <label className="mk-micro" style={{ color: 'rgba(244,241,234,0.5)' }} htmlFor="pilot-church">Church name</label>
      <input id="pilot-church" ref={churchRef} name="church" className={`mk-input${invalid === 'church' ? ' invalid' : ''}`} placeholder="Hanmaum Church" />
      <label className="mk-micro" style={{ color: 'rgba(244,241,234,0.5)' }} htmlFor="pilot-size">Congregation size</label>
      <select id="pilot-size" ref={sizeRef} name="size" className={`mk-input${invalid === 'size' ? ' invalid' : ''}`} defaultValue="Under 100">
        <option>Under 100</option>
        <option>100 – 300</option>
        <option>300 – 800</option>
        <option>800+</option>
      </select>
      <label className="mk-micro" style={{ color: 'rgba(244,241,234,0.5)' }} htmlFor="pilot-email">Your email</label>
      <input id="pilot-email" ref={emailRef} name="email" type="email" className={`mk-input${invalid === 'email' ? ' invalid' : ''}`} placeholder="you@church.org" />
      <button type="submit" className={`mk-btn mk-btn-gold${state === 'success' ? ' sent' : ''}`} disabled={state === 'sending' || state === 'success'} style={{ marginTop: 6 }}>
        {state === 'success' ? "Thank you. We'll be in touch." : state === 'sending' ? 'Sending…' : 'Request a demo'}
      </button>
      <p className="mk-micro" style={{ color: 'rgba(244,241,234,0.42)' }}>We reply within two business days.</p>
    </form>
  );
}

function LanguageForm() {
  const { state, submit } = useContactSubmit('New language request — Shema');
  const [invalid, setInvalid] = useState('');
  const langRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setInvalid('');
    submit(
      { language: langRef.current?.value ?? '', email: emailRef.current?.value ?? '' },
      (name) => {
        setInvalid(name);
        (name === 'language' ? langRef : emailRef).current?.focus();
      },
    );
  };

  return (
    <form onSubmit={onSubmit} noValidate style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', marginTop: 26 }}>
      <input ref={langRef} name="language" className={`mk-input-light${invalid === 'language' ? ' invalid' : ''}`} placeholder="Your language" style={{ flex: '1 1 170px', maxWidth: 260 }} />
      <input ref={emailRef} name="email" type="email" className={`mk-input-light${invalid === 'email' ? ' invalid' : ''}`} placeholder="you@church.org" style={{ flex: '1 1 170px', maxWidth: 260 }} />
      <button type="submit" className={`mk-btn mk-btn-ink${state === 'success' ? ' sent' : ''}`} disabled={state === 'sending' || state === 'success'}>
        {state === 'success' ? "Thank you. We'll be in touch." : state === 'sending' ? 'Sending…' : 'Request it'}
      </button>
      <p className="mk-body-sm" style={{ width: '100%', textAlign: 'center', marginTop: 4 }}>We&apos;ll tell you when it&apos;s ready.</p>
    </form>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function MarketingPage() {
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const watermarkRef = useRef<HTMLDivElement>(null);
  const sanctuaryRef = useRef<HTMLImageElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Reveal on scroll: IntersectionObserver adds a class once; resting state
  // is always visible (the .rv styles only hide under .mk-js).
  useEffect(() => {
    if (!mounted || reduced) return;
    const root = rootRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll('.rv'));
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('on'); obs.unobserve(e.target); } }),
      { threshold: 0.06 },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [mounted, reduced]);

  // Scroll progress + the two parallax layers (each tracks its own progress
  // through the viewport; travel stays inside the sanctuary's overscan).
  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const doc = document.documentElement;
        const denom = doc.scrollHeight - window.innerHeight;
        if (progressRef.current) {
          progressRef.current.style.width = `${denom > 0 ? (window.scrollY / denom) * 100 : 0}%`;
        }
        const vh = window.innerHeight;
        const layer = (el: HTMLElement | null, amount: number) => {
          if (!el) return;
          const rect = el.getBoundingClientRect();
          const p = Math.max(-1.4, Math.min(1.4, (rect.top + rect.height / 2 - vh / 2) / vh));
          el.style.transform = `translateY(${p * Math.abs(amount) * 220 * Math.sign(amount)}px)`;
        };
        layer(watermarkRef.current, 0.16);
        layer(sanctuaryRef.current, -0.09);
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [reduced]);

  return (
    <div ref={rootRef} className={`mk${mounted && !reduced ? ' mk-js' : ''}`}>
      <div ref={progressRef} className="mk-progress" aria-hidden />

      {/* ── Nav ── */}
      <nav className="mk-nav">
        <div className="mk-nav-inner">
          <a href="#top" className="mk-brand">
            <CrossGlyph />
            Shema
          </a>
          <div className="mk-nav-links">
            <a href="#why" className="mk-nav-link mk-nav-hide-sm">Why Shema</a>
            <a href="#how" className="mk-nav-link mk-nav-hide-sm">How it works</a>
            <Link href="/login" className="mk-nav-link">Log in</Link>
            <a href="#demo" className="mk-btn mk-btn-ink" style={{ padding: '10px 20px', fontSize: 13.5 }}>Request a demo</a>
          </div>
        </div>
      </nav>

      {/* ── Hero ── */}
      <header id="top" className="mk-hero">
        <div ref={watermarkRef} className="mk-hero-watermark">
          <CrossWatermark reduced={reduced} />
        </div>
        <div className="mk-hero-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div className="mk-eyebrow rv">
              <span className="mk-hero-rule" />
              한국어 ↔ English · both directions
            </div>
            <h1 className="rv">
              Preached in one language. Heard in another. <em>In real time.</em>
            </h1>
            <p className="mk-hero-lead rv">
              Korean to English and English to Korean, built for how preaching actually
              sounds: the verse citations, the verb that arrives last, the vocabulary
              of the Korean church.
            </p>
            <div className="rv" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <a href="#demo" className="mk-btn mk-btn-ink">Request a demo</a>
              <a href="#how" className="mk-btn mk-btn-outline">See how it works</a>
            </div>
            <div className="rv" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span className="dot" style={{ color: 'var(--sage-ink)', width: 7, height: 7 }} />
              <span className="mk-micro" style={{ color: 'var(--text-4)' }}>
                Serving Korean-American congregations in the Northeast
              </span>
            </div>
          </div>
          <HeroDemo reduced={reduced} />
        </div>
      </header>

      {/* ── Marquee ── */}
      <div className="mk-marquee" aria-hidden>
        <div className="mk-marquee-track">
          {[false, true].map((hidden) => (
            <div key={String(hidden)} style={{ display: 'flex' }} aria-hidden={hidden}>
              {MARQUEE_ITEMS.map(([kr, en]) => (
                <span key={`${kr}-${String(hidden)}`} className="mk-marquee-item">
                  <span lang="ko" className="mk-marquee-kr">{kr}</span>
                  <span className="mk-marquee-en">{en}</span>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ── Sanctuary art band ── */}
      <section className="mk-section">
        <div className="mk-sanctuary rv">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img ref={sanctuaryRef} src="/sanctuary.svg" alt="Line drawing of a sanctuary: nave, arches, altar rail, and a gold cross" />
        </div>
      </section>

      {/* ── Problem (dark) ── */}
      <section id="why" className="mk-night mk-section">
        <div className="mk-wrap" style={{ display: 'flex', flexDirection: 'column', gap: 'clamp(28px, 4vh, 48px)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="mk-eyebrow rv">The problem</div>
            <h2 className="mk-h2 rv" style={{ maxWidth: '20ch' }}>Generic translators break in church.</h2>
            <p className="rv" style={{ color: 'rgba(244,241,234,0.6)', fontSize: 'clamp(16px, 1.5vw, 19px)', lineHeight: 1.6, maxWidth: '56ch' }}>
              Korean and English are among the hardest pairs for a machine, in either
              direction, and a sermon is the worst place to get it wrong.
            </p>
          </div>
          <div className="mk-cards">
            {PROBLEM_CARDS.map((c, i) => (
              <div key={c.title} className="mk-card-dark rv" style={{ transitionDelay: `${i * 0.08}s`, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="mk-card-mono">{c.mono}</div>
                <h3>{c.title}</h3>
                <p className="mk-card-body">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Full-bleed statement ── */}
      <section className="mk-section" style={{ borderBottom: '1px solid var(--rule)', textAlign: 'center' }}>
        <div className="mk-wrap" style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center' }}>
          <div className="mk-eyebrow rv">Why Shema</div>
          <h2 className="mk-statement-h2 rv" style={{ textWrap: 'balance' }}>
            Built for the sermon, <em>not the sentence.</em>
          </h2>
        </div>
      </section>

      {/* ── Capability rows ── */}
      <section className="mk-section" style={{ paddingTop: 0, paddingBottom: 0 }}>
        <div className="mk-wrap">
          {/* 01 */}
          <div className="mk-cap mk-cap-rule">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="mk-cap-num rv">01</div>
              <h3 className="rv">It quotes the verse. It doesn&apos;t guess it.</h3>
              <p className="mk-body rv">
                When your pastor cites scripture, even through a rough microphone,
                Shema recognizes the reference and anchors the English to the actual passage.
              </p>
            </div>
            <VerseMatcherDemo reduced={reduced} />
          </div>

          {/* 02 */}
          <div className="mk-cap mk-cap-rule">
            <WaveformDemo reduced={reduced} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="mk-cap-num rv">02</div>
              <h3 className="rv">It waits for the meaning to arrive.</h3>
              <p className="mk-body rv">
                Korean holds its verb to the end, and preachers hold it longer for effect.
                Shema reads the sentence endings and knows a pause from a full stop.
              </p>
            </div>
          </div>

          {/* 03 + 04 */}
          <div className="mk-cap-pair">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="mk-cap-num rv">03</div>
              <h3 className="rv" style={{ fontSize: 'clamp(26px, 2.8vw, 38px)' }}>It runs both directions on the same Sunday.</h3>
              <p className="mk-body rv">
                Korean into English for the second generation; English into Korean when a
                guest preacher takes the pulpit. Both know the Korean church&apos;s own vocabulary.
              </p>
              <VocabRows reduced={reduced} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="mk-cap-num rv">04</div>
              <h3 className="rv" style={{ fontSize: 'clamp(26px, 2.8vw, 38px)' }}>When it isn&apos;t sure, it stays quiet.</h3>
              <p className="mk-body rv">
                Every line is checked against the last few minutes of the sermon. If
                confidence is low it waits rather than invents. No fabricated theology.
              </p>
              <ContextDemo reduced={reduced} />
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section id="how" className="mk-how mk-section">
        <div className="mk-wrap mk-how-grid">
          <div className="mk-sticky" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="mk-eyebrow rv">How it works</div>
            <h2 className="mk-h2 rv">Nothing changes at the pulpit.</h2>
            <p className="rv serif-en" style={{ fontSize: 'clamp(20px, 2vw, 26px)', color: 'var(--gold-ink)', fontStyle: 'italic' }}>
              Everything changes in the pews.
            </p>
            <div className="rv">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="mk-listener-art" src="/pulpit.svg" alt="Line drawing of a listener wearing an earpiece" />
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                <span style={{ color: 'var(--gold-ink)' }} aria-hidden>✓</span>
                <span className="mk-micro" style={{ color: 'var(--text-4)' }}>
                  Plays through their own phone or your receivers
                </span>
              </div>
            </div>
          </div>
          <div>
            {STEPS.map((s) => (
              <div key={s.n} className="mk-step rv" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="mk-cap-num">{s.n}</div>
                <h3>{s.title}</h3>
                <p className="mk-body">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Setup ── */}
      <section className="mk-section">
        <div className="mk-wrap" style={{ display: 'flex', flexDirection: 'column', gap: 'clamp(24px, 4vh, 40px)' }}>
          <h2 className="mk-h2 rv" style={{ maxWidth: '18ch' }}>Works with the setup you already run.</h2>
          <p className="mk-body rv">
            No new sound system, no hardware to buy. Shema takes the audio you already send
            out, and the translation comes back on whatever your congregation already listens through.
          </p>
          <div className="mk-setup-cards">
            {SETUP_CARDS.map((c, i) => (
              <div key={c.tag} className="mk-setup-card rv" style={{ transitionDelay: `${i * 0.06}s`, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="mk-tag" style={{ color: 'var(--gold-ink)' }}>{c.tag}</div>
                <p className="mk-body-sm">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Statement ── */}
      <section className="mk-section" style={{ textAlign: 'center', borderTop: '1px solid var(--rule)' }}>
        <div className="mk-wrap-prose rv" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
          <CrossGlyph size={32} />
          <p className="serif-en" style={{ fontSize: 'clamp(26px, 3.2vw, 44px)', lineHeight: 1.25, color: 'var(--ink)', textWrap: 'balance' }}>
            Shema doesn&apos;t replace the pastor&apos;s voice. It carries it to everyone in the room.
          </p>
        </div>
      </section>

      {/* ── Demo request (dark) ── */}
      <section id="demo" className="mk-night mk-section">
        <div className="mk-pilot-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <h2 className="mk-h2 rv">Bring it to your church.</h2>
            <p className="rv" style={{ color: 'rgba(244,241,234,0.6)', fontSize: 'clamp(15px, 1.4vw, 17px)', lineHeight: 1.65, maxWidth: '46ch' }}>
              A human interpreter runs $200–500 a Sunday and covers one language. Tell us
              about your congregation and we&apos;ll set up a live demo service. No cost, no commitment.
            </p>
            <div className="rv" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                'We tune it to your pastor on a recent sermon recording first.',
                'Works with the microphone and sound system you already have.',
                'A real person walks your team through the first Sunday.',
              ].map((t) => (
                <div key={t} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                  <span style={{ color: 'var(--gold)' }} aria-hidden>→</span>
                  <span style={{ color: 'rgba(244,241,234,0.75)', fontSize: 15, lineHeight: 1.55 }}>{t}</span>
                </div>
              ))}
            </div>
            <p className="mk-body-sm rv" style={{ color: 'rgba(244,241,234,0.42)' }}>
              Prefer email?{' '}
              <a href="mailto:shematranslate@gmail.com" style={{ color: 'var(--gold)', textDecoration: 'underline' }}>
                shematranslate@gmail.com
              </a>
            </p>
          </div>
          <div className="rv">
            <PilotForm />
          </div>
        </div>
      </section>

      {/* ── Languages ── */}
      <section className="mk-section" style={{ textAlign: 'center' }}>
        <div className="mk-wrap-narrow" style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center' }}>
          <div className="mk-eyebrow rv">More languages coming</div>
          <h2 className="mk-h2 rv" style={{ maxWidth: '18ch' }}>We started with Korean. We&apos;re not stopping there.</h2>
          <p className="mk-body rv" style={{ margin: '0 auto' }}>
            Each new language gets tuned to how preaching actually sounds in that tongue,
            the same way Shema was built for Korean.
          </p>
          <div className="mk-lang-chips rv">
            {['Spanish', 'Mandarin', 'Tagalog', 'Vietnamese'].map((l) => (
              <span key={l} className="mk-lang-chip">{l}</span>
            ))}
          </div>
          <div className="rv" style={{ width: '100%', maxWidth: 640 }}>
            <LanguageForm />
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="mk-footer">
        <div className="mk-footer-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <span className="mk-brand"><CrossGlyph />Shema</span>
            <span className="serif-en" style={{ fontSize: 22, color: 'var(--gold-ink)' }} lang="he">שְׁמַע</span>
            <p className="mk-body-sm" style={{ maxWidth: '38ch' }}>
              &ldquo;Hear, O Israel&rdquo; (Deuteronomy 6:4). The name is our prayer that
              everyone gets to hear.
            </p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="mk-eyebrow" style={{ marginBottom: 4 }}>Product</div>
            <a href="#why">Why Shema</a>
            <a href="#how">How it works</a>
            <a href="#demo">Request a demo</a>
            <Link href="/login">Staff log in</Link>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="mk-eyebrow" style={{ marginBottom: 4 }}>Contact</div>
            <a href="mailto:shematranslate@gmail.com">shematranslate@gmail.com</a>
            <p className="mk-body-sm">© 2026 Shema · Made for the multilingual sanctuary</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
