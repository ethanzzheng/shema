/**
 * A still of the broadcast desk, for the demo's closing screen.
 *
 * The demo shows the congregation's half of the product — captions and a voice.
 * The half a pastor is actually buying is the operator's: what the person at
 * the sound desk looks at on a Sunday morning. This mirrors that surface so the
 * question "what does my volunteer have to do?" has an answer before the call.
 *
 * It is deliberately inert — divs, not buttons, so nobody tabs into a dead
 * control — and mirrors the real rail in /speak. If that rail gains or loses a
 * card, this should follow, or it stops being an honest likeness.
 */

const LINES: Array<{ ko: string; en: string }> = [
  {
    ko: '사랑하는 성도 여러분, 오늘 함께 나눌 말씀은 베드로전서 2장 9절입니다.',
    en: 'Beloved congregation, the passage we share today is 1 Peter 2:9.',
  },
  {
    ko: '여러분은 택하신 족속이요, 왕 같은 제사장이요, 거룩한 나라입니다.',
    en: 'You are a chosen people, a royal priesthood, a holy nation.',
  },
  {
    ko: '이것은 우리가 잘나서가 아니라, 오직 하나님의 은혜 때문입니다.',
    en: 'This is not because of anything in us, but only because of God’s grace.',
  },
  {
    ko: '이번 주 목장 모임에서도 이 말씀을 함께 나누시기 바랍니다.',
    en: 'Please share this passage at your Mokjang meeting this week.',
  },
];

/** Fixed heights: a random meter would redraw differently on every render. */
const METER = [34, 52, 71, 48, 83, 61, 39, 74, 56, 88, 45, 67, 30, 59, 76, 42];

export default function DeskPreview() {
  return (
    <figure className="dp-figure">
      <div className="dp-scroll">
        <div className="dp-desk" aria-hidden="true">
          <div className="dp-top">
            <span className="dp-brand">✝ SHEMA</span>
            <span className="dp-divider" />
            <span className="dp-title">Broadcast desk</span>
            <span className="dp-room">grace-korean</span>
            <span className="dp-live">
              <i className="dp-dot" /> ON AIR
            </span>
          </div>

          <div className="dp-body">
            <aside className="dp-rail">
              <div className="dp-stop">■ Stop broadcast</div>

              <div className="dp-card">
                <span className="dp-label">Direction</span>
                <div className="dp-seg">
                  <span className="dp-seg-on">한국어 → EN</span>
                  <span>EN → 한국어</span>
                </div>
              </div>

              <div className="dp-card">
                <span className="dp-label">Sound source</span>
                <div className="dp-select">Sanctuary mixer</div>
                <div className="dp-meter">
                  {METER.map((h, i) => (
                    <i key={i} style={{ height: `${h}%` }} />
                  ))}
                  <span className="dp-meter-tag">GOOD</span>
                </div>
              </div>

              <div className="dp-card">
                <div className="dp-card-head">
                  <span className="dp-label">Pacing</span>
                  <span className="dp-label">Safe to change on air</span>
                </div>
                <div className="dp-seg">
                  <span>Fast</span>
                  <span className="dp-seg-on dp-seg-plain">Smooth</span>
                </div>
              </div>

              <div className="dp-card">
                <div className="dp-card-head">
                  <span className="dp-label">Glossary</span>
                  <span className="dp-label">6</span>
                </div>
                <div className="dp-input">목장=Mokjang</div>
                <p className="dp-hint">Added terms apply to the next sentence.</p>
              </div>

              <div className="dp-card dp-card-gold">
                <span className="dp-label">Congregation link</span>
                <div className="dp-link-row">
                  <span className="dp-link">tryshema.app/l/grace-korean</span>
                  <span className="dp-qr" />
                </div>
              </div>
            </aside>

            <section className="dp-main">
              <div className="dp-stats">
                <div>
                  <span className="dp-label">Hearing the pastor</span>
                  <strong className="dp-stat dp-stat-ok">● Clear</strong>
                </div>
                <div>
                  <span className="dp-label">Delay to the pews</span>
                  <strong className="dp-stat">1.4s</strong>
                </div>
                <div>
                  <span className="dp-label">Listening now</span>
                  <strong className="dp-stat">38 people</strong>
                </div>
              </div>

              <div className="dp-panel">
                <div className="dp-cols">
                  <span className="dp-label">한국어 · spoken</span>
                  <span className="dp-label">English · sent to the pews</span>
                </div>
                {LINES.map((l) => (
                  <div className="dp-pair" key={l.en}>
                    <p className="dp-ko">{l.ko}</p>
                    <p className="dp-en">{l.en}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
      <figcaption className="dp-caption">
        The operator’s view during a service. One person starts it, watches the input
        meter, and fixes a name on the fly — the glossary entry above is why 목장 reaches
        the pews as “Mokjang” and not “livestock farm”.
      </figcaption>
    </figure>
  );
}
