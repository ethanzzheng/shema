'use client';

/**
 * V3 "Parallel": the bilingual Bible many of these congregations already own,
 * where the source text and the English sit in facing columns. The whole page
 * is set as parallel text on bookcloth navy, with the ribbon marker as the one
 * accent. The headline itself is a parallel pair, and the live transcript
 * fills in under it row by row.
 */

import Link from 'next/link';
import { LANGS, LANG_ORDER, STEPS } from '@/components/home/data';
import { LangPicker, langPhrase, useVerseCycle } from '@/components/home/shared';
import type { VersionProps } from './page';


export default function V3Parallel({ selected, onSelect, hero, holdRef, reduced }: VersionProps) {
  const L = LANGS[hero.lang];
  const { verse, lit, shownFull } = useVerseCycle(selected, reduced);
  const challenges = selected
    ? LANGS[selected].challenges.map((c) => ({ ...c, lang: selected }))
    : LANG_ORDER.map((id) => ({ ...LANGS[id].challenges[0], lang: id }));
  const glossary = selected
    ? LANGS[selected].glossary.map((g) => ({ ...g, lang: selected }))
    : LANG_ORDER.flatMap((id) => LANGS[id].glossary.slice(0, 2).map((g) => ({ ...g, lang: id })));
  const typing = hero.src && !hero.ref && hero.en.length === 0;
  const last = hero.history[hero.history.length - 1];
  // The pair being typed shows below the finished rows until it lands in history.
  const live = !last || last.src !== hero.src || hero.lang !== last.lang;

  return (
    <div className="v3">
      <nav className="v3-nav">
        <a href="#top" className="v3-brand">Shema</a>
        <div className="v3-nav-links">
          <a href="#how" className="v3-hide-sm">How it works</a>
          <Link href="/login">Log in</Link>
          <a href="/demo" className="v3-btn v3-btn-ribbon">Try it live</a>
        </div>
      </nav>

      <header id="top" className="v3-hero">
        <span className="v3-ribbon" aria-hidden />
        <div className="v3-spread">
          <h1 className="v3-h1">
            <span className="v3-h1-l">
              Preached in{' '}
              <LangPicker shown={hero.lang} selected={selected} onSelect={onSelect} holdRef={holdRef} className="v3-lp" menuClassName="v3-menu" />
            </span>
            <span className="v3-h1-r">Heard in English.</span>
          </h1>

          <div className="v3-cols-head" aria-hidden>
            <span lang={selected ? L.htmlLang : undefined}>{selected ? `${L.native}${L.status === 'soon' ? ' · preview' : ''}` : 'Spoken'}</span>
            <span>English</span>
          </div>
          <ol className="v3-transcript" aria-label="Example live transcript">
            {hero.history.map((h) => (
              <li key={`${h.lang}-${h.key}`} className="v3-pair">
                <p className="v3-src" lang={LANGS[h.lang].htmlLang}>
                  {!selected && <span className="v3-row-lang" lang="en">{LANGS[h.lang].name}</span>}
                  {h.src}
                </p>
                <p className="v3-en">
                  {h.en}
                  {h.ref && <span className="v3-ref">{h.ref}</span>}
                </p>
              </li>
            ))}
            {live && (
              <li className="v3-pair v3-pair-live">
                <p className="v3-src" lang={L.htmlLang}>
                  {!selected && <span className="v3-row-lang" lang="en">{L.name}</span>}
                  {hero.src}<span className={`v3-caret${typing ? ' on' : ''}`} aria-hidden /></p>
                <p className="v3-en">{hero.en}</p>
              </li>
            )}
          </ol>
        </div>
        <div className="v3-hero-foot">
          <p>
            Live sermon translation into a natural English voice and captions, on each listener&apos;s
            own phone. About two seconds behind the pastor.
          </p>
          <div className="v3-ctas">
            <a href="/demo" className="v3-btn v3-btn-ribbon">Try it live</a>
            <a href="#demo" className="v3-btn v3-btn-line">Request a demo</a>
          </div>
        </div>
      </header>

      <section className="v3-section" id="why">
        <h2 className="v3-h2">Where a word-for-word machine goes wrong.</h2>
        <div className="v3-notes">
          {challenges.map((c, i) => (
            <div key={c.title} className="v3-note">
              <p className="v3-note-src" lang={LANGS[c.lang].htmlLang}>
                {c.sample}<sup>{String.fromCharCode(97 + i)}</sup>
              </p>
              <div className="v3-note-body">
                <p className="v3-note-miss"><sup>{String.fromCharCode(97 + i)}</sup> {!selected && `${LANGS[c.lang].name}. `}Generic tool: {c.miss}</p>
                <h3>{c.title}</h3>
                <p>{c.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="v3-section v3-verse">
        <div className="v3-verse-copy">
          <h2 className="v3-h2">It quotes the verse. It doesn&apos;t guess it.</h2>
          <p className="v3-muted">
            When the pastor cites scripture in {langPhrase(selected)}, Shema finds the passage
            and anchors the English to it.
          </p>
        </div>
        <div className="v3-page">
          <p className="v3-cite" lang={LANGS[verse.lang].htmlLang}>
            {verse.spoken.map((t, i) => (
              <span key={`${verse.lang}-${verse.ref}-${i}`} className={i < lit ? 'lit' : ''}>{t}</span>
            ))}
          </p>
          <p className={`v3-verse-en${shownFull ? ' on' : ''}`}>
            <span className="v3-ref">{verse.ref}</span>
            {verse.text}
          </p>
        </div>
      </section>

      <section className="v3-section" id="how">
        <h2 className="v3-h2">Nothing changes at the pulpit.</h2>
        <ol className="v3-steps">
          {STEPS.map((s) => (
            <li key={s.title}>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="v3-section v3-gloss">
        <h2 className="v3-h2">Your church&apos;s own words.</h2>
        <p className="v3-muted">Ministries, hymns and names, added once and used every Sunday.</p>
        <dl className="v3-gloss-list">
          {glossary.map((g) => (
            <div key={g.src} className="v3-gloss-row">
              <dt lang={LANGS[g.lang].htmlLang}>{g.src}</dt>
              <dd>{g.en}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="v3-close" id="demo">
        <div className="v3-close-inner">
        <h2 className="v3-close-h">Bring it to your church.</h2>
        <p className="v3-muted">
          We&apos;ll set up a live demo service in {langPhrase(selected, 'Mandarin, Korean or Cantonese')}.
          No cost, no commitment.{selected === 'yue' && ' Cantonese is in development; early churches help us tune it.'}
        </p>
        <div className="v3-ctas">
          <a href="mailto:shematranslate@gmail.com?subject=Demo%20request" className="v3-btn v3-btn-ribbon">Request a demo</a>
          <a href="/demo" className="v3-btn v3-btn-line">Try it live</a>
        </div>
        </div>
      </section>

      <footer className="v3-foot">
        <span className="v3-brand">Shema</span>
        <span lang="he" className="v3-foot-he">שְׁמַע</span>
        <a href="mailto:shematranslate@gmail.com">shematranslate@gmail.com</a>
      </footer>
    </div>
  );
}
