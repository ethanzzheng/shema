'use client';

/**
 * App screens tab: pick a screen, see it at desktop size or inside phones.
 * Phone frames load the same screen with ?embed=1, so they are real
 * viewports (layout, scrolling, tap targets), not scaled pictures.
 */

import { Desk, Home, Login, SCREENS, type ScreenId } from './AppScreens';
import { Glossary, Kiosk, Listener, TranscriptDetail, Transcripts } from './AppScreens2';
import { Phone } from './MobileMockups';

export function AppScreen({ id, state }: { id: ScreenId; state?: string | null }) {
  switch (id) {
    case 'login': return <Login />;
    case 'home': return <Home />;
    case 'desk': return <Desk />;
    case 'kiosk': return <Kiosk />;
    case 'listen': return <Listener state={(state as 'join' | 'tap' | 'live') || 'live'} />;
    case 'glossary': return <Glossary />;
    case 'transcripts': return <Transcripts />;
    case 'transcript': return <TranscriptDetail />;
  }
}

export default function AppTab({ screen, view, onScreen, onView }: {
  screen: ScreenId; view: 'desktop' | 'phone'; onScreen: (s: ScreenId) => void; onView: (v: 'desktop' | 'phone') => void;
}) {
  const src = (s: ScreenId, state?: string) => `/landing-lab?v=app&s=${s}&embed=1${state ? `&state=${state}` : ''}`;
  const phoneOnly = screen === 'listen';
  return (
    <div className="v2 ap-tab">
      <div className="ap-tabbar">
        <nav className="ap-screens" aria-label="Screens">
          {SCREENS.map((s) => (
            <button key={s.id} type="button" className={s.id === screen ? 'on' : ''} aria-current={s.id === screen ? 'page' : undefined} onClick={() => onScreen(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        {!phoneOnly && (
          <div className="ap-seg ap-viewseg" role="radiogroup" aria-label="View">
            {(['desktop', 'phone'] as const).map((v) => (
              <button key={v} type="button" role="radio" aria-checked={view === v} className={view === v ? 'on' : ''} onClick={() => onView(v)}>
                {v === 'desktop' ? 'Desktop' : 'Phone'}
              </button>
            ))}
          </div>
        )}
      </div>

      {phoneOnly ? (
        <div className="mm ap-phones">
          <div className="mm-row">
            <Phone name="Join (no code in the link)" w={393} h={852} island src={src('listen', 'join')} scale={0.75} />
            <Phone name="From the QR code" w={393} h={852} island src={src('listen', 'tap')} scale={0.75} />
            <Phone name="Listening" w={393} h={852} island src={src('listen', 'live')} scale={0.75} />
          </div>
        </div>
      ) : view === 'phone' ? (
        <div className="mm ap-phones">
          <div className="mm-row">
            <Phone name="iPhone 15" w={393} h={852} island src={src(screen)} scale={0.75} />
            <Phone name="Android (small)" w={360} h={800} island={false} src={src(screen)} scale={0.75} />
          </div>
        </div>
      ) : (
        <div className="ap-stage"><AppScreen id={screen} /></div>
      )}
    </div>
  );
}
