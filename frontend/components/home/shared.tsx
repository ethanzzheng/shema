'use client';

/**
 * Behaviour shared by every landing-lab version: the hero's live caption
 * cycle and the "Preached in ___" language picker. Each version supplies its
 * own look through className hooks; nothing here sets colour.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CaretDown, Check } from '@phosphor-icons/react';
import { LANGS, LANG_ORDER, type CaptionPair, type LangId } from './data';

export function useReducedMotion(): boolean {
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

/** What a homepage version receives from its host (the real page or the lab). */
export interface VersionProps {
  selected: LangId | null;
  onSelect: (id: LangId) => void;
  hero: HeroCycle;
  holdRef: React.MutableRefObject<boolean>;
  reduced: boolean;
  /** English is the spoken side (English → the selected language). */
  flip: boolean;
  setFlip: (f: boolean) => void;
}

export interface HeroCycle {
  /** The language the hero is showing: the selection, or the auto-cycled one. */
  lang: LangId;
  src: string;
  en: string;
  ref: string;
  /** Completed pairs, newest last (for transcript-style layouts). */
  history: (CaptionPair & { lang: LangId; key: number })[];
}

/** Rounds through all three languages before the hero settles on Mandarin. */
const AUTO_ROUNDS = 2;

/**
 * Types each caption pair out source-first, then English, like the listener
 * view fills in. With no selection the language advances after every pair, so
 * a visitor who never touches the picker still sees all three.
 */
export function useHeroCycle(
  selected: LangId | null,
  reduced: boolean,
  holdRef: React.MutableRefObject<boolean>,
  /** English is the spoken side: type the English first, then the translation. */
  flip = false,
): HeroCycle {
  const [lang, setLang] = useState<LangId>(selected ?? 'zh');
  const [src, setSrc] = useState('');
  const [en, setEn] = useState('');
  const [ref, setRef] = useState('');
  const [history, setHistory] = useState<HeroCycle['history']>([]);
  const run = useRef(0);

  useEffect(() => {
    const me = ++run.current;
    const alive = () => run.current === me;
    const start = selected ?? 'zh';
    setLang(start);
    setHistory([]);

    if (reduced) {
      const p = LANGS[start].captions[0];
      setSrc(p.src); setEn(p.en); setRef(p.ref ?? '');
      setHistory(LANGS[start].captions.slice(0, 3).map((c, i) => ({ ...c, lang: start, key: i })));
      return;
    }

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const type = async (text: string, speed: number, set: (s: string) => void) => {
      for (let i = 1; i <= text.length; i++) {
        if (!alive()) return;
        set(text.slice(0, i));
        await sleep(speed);
      }
    };

    // Open on two finished lines so the first viewport is never an empty
    // transcript; typing picks up from the third.
    const seed = LANGS[start].captions.slice(0, 2).map((c, i) => ({ ...c, lang: start, key: i }));
    setHistory(seed);

    (async () => {
      let li = LANG_ORDER.indexOf(start);
      const perLang: Record<LangId, number> = { zh: 0, ko: 0, yue: 0 };
      perLang[start] = seed.length;
      let shown = 0;
      let key = seed.length;
      await sleep(200);
      while (alive()) {
        const id = selected ?? LANG_ORDER[li % LANG_ORDER.length];
        const caps = LANGS[id].captions;
        const p = caps[perLang[id]++ % caps.length];
        setLang(id);
        setSrc(''); setEn(''); setRef('');
        if (flip) {
          await type(p.en, 26, setEn);
          if (!alive()) return;
          await sleep(380);
          await type(p.src, 70, setSrc);
        } else {
          await type(p.src, 70, setSrc);
          if (!alive()) return;
          await sleep(380);
          await type(p.en, 26, setEn);
        }
        if (!alive()) return;
        setRef(p.ref ?? '');
        const k = key++;
        setHistory((h) => [...h, { ...p, lang: id, key: k }].slice(-4));
        await sleep(2600);
        shown++;
        // Hovering or focusing the picker holds the language still, so it
        // never changes under someone's pointer.
        if (!selected && !holdRef.current && shown < AUTO_ROUNDS * LANG_ORDER.length) li++;
        else if (!selected && shown >= AUTO_ROUNDS * LANG_ORDER.length) li = 0;
      }
    })();
    return () => { run.current++; };
  }, [selected, reduced, holdRef, flip]);

  return { lang, src, en, ref, history };
}

/**
 * The word in "Preached in ___". A real button: it opens a short list of the
 * three languages. Every name is stacked in one grid cell so the headline
 * never reflows as the shown name changes.
 */
export function LangPicker({
  shown,
  selected,
  onSelect,
  holdRef,
  className = '',
  menuClassName = '',
}: {
  shown: LangId;
  selected: LangId | null;
  onSelect: (id: LangId) => void;
  holdRef: React.MutableRefObject<boolean>;
  className?: string;
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    holdRef.current = false;
    if (refocus) button.current?.focus();
  }, [holdRef]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onDown);
    const cur = LANG_ORDER.indexOf(selected ?? shown);
    items.current[cur]?.focus();
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, close, selected, shown]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const i = items.current.findIndex((el) => el === document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items.current[(i + 1) % LANG_ORDER.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items.current[(i + LANG_ORDER.length - 1) % LANG_ORDER.length]?.focus(); }
    else if (e.key === 'Tab') close(false);
  };

  return (
    <span
      ref={wrap}
      className={`lp ${className}`}
      onPointerEnter={() => { holdRef.current = true; }}
      onPointerLeave={() => { if (!open) holdRef.current = false; }}
    >
      <button
        ref={button}
        type="button"
        className="lp-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Preached in ${LANGS[shown].name}. Choose a language`}
        onClick={() => { holdRef.current = true; setOpen((o) => !o); }}
        onFocus={() => { holdRef.current = true; }}
        onBlur={() => { if (!open) holdRef.current = false; }}
      >
        <span className="lp-stack" aria-hidden>
          {LANG_ORDER.map((id) => (
            <span key={id} className={`lp-word${id === shown ? ' on' : ''}`} lang="en">
              {LANGS[id].name}
            </span>
          ))}
        </span>
        <CaretDown className="lp-caret" weight="bold" aria-hidden />
      </button>
      {open && (
        <span id={menuId} role="menu" className={`lp-menu ${menuClassName}`} onKeyDown={onMenuKey}>
          {LANG_ORDER.map((id, i) => {
            const L = LANGS[id];
            const on = id === selected;
            return (
              <button
                key={id}
                ref={(el) => { items.current[i] = el; }}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                className={`lp-item${on ? ' on' : ''}`}
                onClick={() => { onSelect(id); close(true); }}
              >
                <span className="lp-item-name">{L.name}</span>
                <span className="lp-item-native" lang={L.htmlLang}>{L.native}</span>
                {L.status === 'soon' && <span className="lp-soon">Coming soon</span>}
                {on && <Check className="lp-check" weight="bold" aria-hidden />}
              </button>
            );
          })}
        </span>
      )}
    </span>
  );
}

/** "Mandarin" when chosen, otherwise the neutral phrase. */
export function langPhrase(selected: LangId | null, neutral = "your pastor's language"): string {
  return selected ? LANGS[selected].name : neutral;
}

/** Cycles a set of verse citations, lighting the spoken words in turn. */
export function useVerseCycle(selected: LangId | null, reduced: boolean) {
  const list = selected
    ? LANGS[selected].verses.map((v) => ({ ...v, lang: selected }))
    : LANG_ORDER.map((id) => ({ ...LANGS[id].verses[0], lang: id }));
  const [i, setI] = useState(0);
  const [lit, setLit] = useState(reduced ? 3 : 0);
  const key = selected ?? 'all';

  useEffect(() => {
    setI(0);
    if (reduced) { setLit(3); return; }
    let n = 0;
    let idx = 0;
    setLit(0);
    const id = setInterval(() => {
      n++;
      if (n <= 3) setLit(n);
      if (n >= 3 + 7) { n = 0; idx++; setI(idx); setLit(0); }
    }, 520);
    return () => clearInterval(id);
  }, [key, reduced]);

  const v = list[i % list.length];
  return { verse: v, lit, shownFull: lit >= 3 };
}
