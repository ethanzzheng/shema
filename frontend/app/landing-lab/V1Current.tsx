'use client';

/**
 * V1 "Current": today's homepage (night ground, congregation photograph,
 * gold accent) re-pointed at Mandarin, Korean and Cantonese. It reuses the
 * homepage's own .mk classes from marketing.css so it stays a faithful
 * mirror; lab.css only adds the picker and the language panel.
 */

import Link from 'next/link';
import { LANGS, LANG_ORDER, STEPS } from '@/components/home/data';
import { LangPicker, langPhrase, useVerseCycle } from '@/components/home/shared';
import type { VersionProps } from './page';

function Cross({ size = 20 }: { size?: number }) {
  return (
    <svg width={size * 0.75} height={size} viewBox="0 0 24 32" fill="none" aria-hidden>
      <line x1="12" y1="1" x2="12" y2="31" stroke="var(--gold-ink)" strokeWidth="1.7" strokeLinecap="round" />
      <line x1="3" y1="10" x2="21" y2="10" stroke="var(--gold-ink)" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export default function V1Current({ selected, onSelect, hero, holdRef, reduced }: VersionProps) {
  const L = LANGS[hero.lang];
  const { verse, lit, shownFull } = useVerseCycle(selected, reduced);
  const challenges = selected
    ? LANGS[selected].challenges.map((c) => ({ ...c, lang: selected }))
    : LANG_ORDER.map((id) => ({ ...LANGS[id].challenges[0], lang: id }));
  const glossary = selected
    ? LANGS[selected].glossary.map((g) => ({ ...g, lang: selected }))
    : LANG_ORDER.map((id) => ({ ...LANGS[id].glossary[0], lang: id }));

  return (
    <div className="mk v1">
      <nav className="mk-nav v1-nav">
        <div className="mk-nav-inner">
          <a href="#top" className="mk-brand"><Cross />Shema</a>
          <div className="mk-nav-links">
            <a href="#why" className="mk-nav-link mk-nav-hide-sm">Why Shema</a>
            <a href="#how" className="mk-nav-link mk-nav-hide-sm">How it works</a>
            <Link href="/login" className="mk-nav-link">Log in</Link>
            <a href="/demo" className="mk-btn mk-btn-ink v1-nav-cta">Try it live</a>
          </div>
        </div>
      </nav>

      <header id="top" className="mk-hero">
        <div className="mk-hero-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div className="mk-eyebrow">
              <span className="mk-hero-rule" />
              中文 · 한국어 · 廣東話 into English
            </div>
            <h1>
              Preached in{' '}
              <LangPicker shown={hero.lang} selected={selected} onSelect={onSelect} holdRef={holdRef} className="v1-lp" menuClassName="v1-menu" />
              . Heard in English. <em>In real time.</em>
            </h1>
            <p className="mk-hero-lead">
              {selected
                ? `${L.name} sermons translated into a natural English voice, built for how ${L.name} preaching actually sounds.`
                : 'Mandarin, Korean and Cantonese sermons translated into a natural English voice, built for how preaching actually sounds.'}
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <a href="/demo" className="mk-btn mk-btn-ink">Try it live</a>
              <a href="#demo" className="mk-btn mk-btn-outline">Request a demo</a>
            </div>
          </div>

          <div className="mk-demo" aria-live="off">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="mk-micro" style={{ color: 'var(--sage)' }}>Live</span>
              {L.status === 'soon' && <span className="mk-micro" style={{ color: 'rgba(244,241,234,0.6)' }}>Preview · coming soon</span>}
            </div>
            <div className="mk-demo-label" style={{ marginTop: 18 }}>{L.native} · Spoken</div>
            <p className="mk-demo-src v1-src" lang={L.htmlLang}>{hero.src}</p>
            <hr className="mk-demo-hr" />
            <div className="mk-demo-label">English · Heard in the pews</div>
            <p className="mk-demo-out v1-out">{hero.en}</p>
            <div className="mk-chip" style={{ opacity: hero.ref ? 1 : 0 }} aria-hidden={!hero.ref}>
              {hero.ref ? `${hero.ref} · matched` : 'Verse matched'}
            </div>
          </div>
        </div>
      </header>

      <section id="why" className="mk-night mk-section">
        <div className="mk-wrap" style={{ display: 'flex', flexDirection: 'column', gap: 'clamp(28px, 4vh, 48px)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <h2 className="mk-h2" style={{ maxWidth: '20ch' }}>Generic translators break in church.</h2>
            <p style={{ color: 'rgba(244,241,234,0.66)', fontSize: 'clamp(16px, 1.5vw, 19px)', lineHeight: 1.6, maxWidth: '56ch' }}>
              {selected
                ? `${L.name} into English is a hard pair for a machine, and a sermon is the worst place to get it wrong.`
                : 'Each language breaks a machine translator in its own way, and a sermon is the worst place to get it wrong.'}
            </p>
          </div>
          <div className="mk-cards">
            {challenges.map((c) => (
              <div key={c.title} className="mk-card-dark" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="mk-card-mono">
                  {!selected && <span className="v1-card-lang">{LANGS[c.lang].name}</span>}
                  <span lang={LANGS[c.lang].htmlLang}>{c.sample}</span> → {c.miss}
                </div>
                <h3>{c.title}</h3>
                <p className="mk-card-body">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mk-section" style={{ borderBottom: '1px solid var(--rule)', textAlign: 'center' }}>
        <div className="mk-wrap">
          <h2 className="mk-statement-h2" style={{ textWrap: 'balance' }}>
            Built for the sermon, <em>not the sentence.</em>
          </h2>
        </div>
      </section>

      <section className="mk-section" style={{ paddingTop: 0, paddingBottom: 0 }}>
        <div className="mk-wrap">
          <div className="mk-cap mk-cap-rule">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h3>It quotes the verse. It doesn&apos;t guess it.</h3>
              <p className="mk-body">
                When the pastor cites scripture in {langPhrase(selected)}, Shema recognizes
                the reference and anchors the English to the actual passage.
              </p>
            </div>
            <div className="mk-verse-demo">
              <div className="mk-micro" style={{ color: 'var(--text-4)', marginBottom: 14 }}>Heard on the mic · {LANGS[verse.lang].name}</div>
              <div>
                {verse.spoken.map((t, i) => (
                  <span key={`${verse.ref}-${verse.lang}-${i}`} lang={LANGS[verse.lang].htmlLang} className={`mk-verse-token${i < lit ? ' lit' : ''}`}>{t}</span>
                ))}
              </div>
              <div className={`mk-verse-out${shownFull ? ' shown' : ''}`}>
                <div className="mk-tag" style={{ color: 'var(--gold-ink)', marginBottom: 6 }}>{verse.ref} · matched</div>
                <p style={{ fontSize: 'clamp(18px, 1.9vw, 23px)', lineHeight: 1.45, color: 'var(--ink)' }}>{verse.text}</p>
              </div>
            </div>
          </div>

          <div className="mk-cap">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <h3>It speaks your church&apos;s vocabulary.</h3>
              <p className="mk-body">
                Add your church&apos;s own words once: ministries, hymns, names. Shema uses
                them every Sunday.
              </p>
            </div>
            <div>
              {glossary.map((g) => (
                <div key={g.src} className="mk-vocab-row on">
                  <span lang={LANGS[g.lang].htmlLang} className="mk-vocab-kr v1-gloss-src">{g.src}</span>
                  <span className="mk-vocab-arrow" aria-hidden>→</span>
                  <span className="mk-vocab-en">{g.en}</span>
                  <span className="mk-tag mk-vocab-tag">{LANGS[g.lang].name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="how" className="mk-how mk-section">
        <div className="mk-wrap mk-how-grid">
          <div className="mk-sticky" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <h2 className="mk-h2">Nothing changes at the pulpit.</h2>
            <p style={{ fontSize: 'clamp(20px, 2vw, 26px)', color: 'var(--gold-ink)' }}>Everything changes in the pews.</p>
          </div>
          <div>
            {STEPS.map((s) => (
              <div key={s.title} className="mk-step" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <h3>{s.title}</h3>
                <p className="mk-body">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mk-section">
        <div className="mk-wrap" style={{ display: 'flex', flexDirection: 'column', gap: 'clamp(24px, 4vh, 40px)' }}>
          <h2 className="mk-h2" style={{ maxWidth: '18ch' }}>Three languages, each tuned on its own.</h2>
          <div className="v1-langs">
            {LANG_ORDER.map((id) => {
              const X = LANGS[id];
              return (
                <button
                  key={id}
                  type="button"
                  className={`v1-lang${selected === id ? ' on' : ''}`}
                  onClick={() => { onSelect(id); window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' }); }}
                >
                  <span className="v1-lang-native" lang={X.htmlLang}>{X.native}</span>
                  <span className="v1-lang-name">{X.name} into English</span>
                  <span className={`v1-lang-status${X.status === 'soon' ? ' soon' : ''}`}>{X.status === 'soon' ? 'Coming soon' : 'Available'}</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section id="demo" className="mk-night mk-section">
        <div className="mk-wrap-prose" style={{ display: 'flex', flexDirection: 'column', gap: 18, alignItems: 'flex-start' }}>
          <h2 className="mk-h2">Bring it to your church.</h2>
          <p style={{ color: 'rgba(244,241,234,0.66)', fontSize: 'clamp(15px, 1.4vw, 17px)', lineHeight: 1.65, maxWidth: '50ch' }}>
            Tell us about your congregation and we&apos;ll set up a live demo service in{' '}
            {langPhrase(selected, 'Mandarin, Korean or Cantonese')}. No cost, no commitment.
          </p>
          <a href="mailto:shematranslate@gmail.com?subject=Demo%20request" className="mk-btn mk-btn-gold">Request a demo</a>
        </div>
      </section>

      <footer className="mk-footer">
        <div className="mk-footer-grid">
          <span className="mk-brand"><Cross />Shema</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <a href="/demo">Try it live</a>
            <Link href="/login">Staff log in</Link>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <a href="mailto:shematranslate@gmail.com">shematranslate@gmail.com</a>
            <p className="mk-body-sm">© 2026 Shema</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
