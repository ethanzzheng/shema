'use client';

/**
 * Landing lab: side-by-side directions for a homepage that sells Shema to
 * Mandarin, Korean and Cantonese churches. The bar at the top is preview
 * chrome, not part of any design. ?v= picks the version and ?lang= the
 * language, so any combination can be linked.
 */

import { Suspense, useCallback, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { LANG_ORDER, type LangId } from '@/components/home/data';
import { useHeroCycle, useReducedMotion, type VersionProps } from '@/components/home/shared';
import V1Current from './V1Current';
import V2Simple from '@/components/home/HomeV2';
import V3Parallel from './V3Parallel';
import MobileMockups from './MobileMockups';
import AppTab, { AppScreen } from './AppTab';
import { SCREENS, type ScreenId } from './AppScreens';
import './lab.css';

const VERSIONS = [
  { id: '1', label: 'Current', Comp: V1Current },
  { id: '2', label: 'Simple', Comp: V2Simple },
  { id: '3', label: 'Parallel', Comp: V3Parallel },
] as const;
/** Not a version: V2 inside phone frames. */
const MOBILE_TAB = 'm';

export type { VersionProps };

function Lab() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const mobile = params.get('v') === MOBILE_TAB;
  const app = params.get('v') === 'app';
  const screen = (SCREENS.find((x) => x.id === params.get('s'))?.id ?? 'login') as ScreenId;
  const appView = params.get('view') === 'phone' ? 'phone' : 'desktop';
  // Inside a Mobile-tab phone frame: the page alone, as a phone would get it.
  const embed = params.get('embed') === '1';
  const v = VERSIONS.find((x) => x.id === params.get('v')) ?? VERSIONS[0];
  const rawLang = params.get('lang');
  const selected = (LANG_ORDER as string[]).includes(rawLang ?? '') ? (rawLang as LangId) : null;
  const reduced = useReducedMotion();
  const holdRef = useRef(false);
  const [flip, setFlip] = useState(false);
  const hero = useHeroCycle(selected, reduced, holdRef, flip);

  const setParam = useCallback((key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value); else next.delete(key);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [params, router, pathname]);

  const { Comp } = v;
  const page = (
    <Comp
      selected={selected}
      onSelect={(id) => setParam('lang', id)}
      hero={hero}
      holdRef={holdRef}
      reduced={reduced}
      flip={flip}
      setFlip={setFlip}
    />
  );
  if (embed && app) return <><style>{':root { --lab-h: 0px; }'}</style><div className="v2 ap-embed"><AppScreen id={screen} state={params.get('state')} /></div></>;
  if (embed) return <><style>{':root { --lab-h: 0px; }'}</style>{page}</>;
  return (
    <>
      <div className="lab-chrome" role="navigation" aria-label="Landing page versions">
        <span className="lab-chrome-name">Landing lab</span>
        <div className="lab-tabs" role="tablist">
          {VERSIONS.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={!mobile && !app && x.id === v.id}
              className={`lab-tab${!mobile && !app && x.id === v.id ? ' on' : ''}`}
              onClick={() => { setParam('v', x.id); window.scrollTo({ top: 0 }); }}
            >
              <span className="lab-tab-n">V{x.id}</span> {x.label}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={mobile}
            className={`lab-tab${mobile ? ' on' : ''}`}
            onClick={() => { setParam('v', MOBILE_TAB); window.scrollTo({ top: 0 }); }}
          >
            <span className="lab-tab-n">V2</span> Mobile
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={app}
            className={`lab-tab${app ? ' on' : ''}`}
            onClick={() => { setParam('v', 'app'); window.scrollTo({ top: 0 }); }}
          >
            <span className="lab-tab-n">V2</span> App screens
          </button>
        </div>
        {selected && (
          <button type="button" className="lab-reset" onClick={() => setParam('lang', null)}>
            Clear<span className="lab-reset-word"> language</span>
          </button>
        )}
      </div>
      {app ? (
        <AppTab screen={screen} view={appView} onScreen={(id) => setParam('s', id)} onView={(x) => setParam('view', x === 'phone' ? 'phone' : null)} />
      ) : mobile ? <MobileMockups lang={selected} /> : page}
    </>
  );
}

export default function LandingLabPage() {
  return (
    <Suspense fallback={null}>
      <Lab />
    </Suspense>
  );
}
