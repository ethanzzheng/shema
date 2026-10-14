'use client';

/**
 * Mobile tab: the chosen version (V2) running live inside phone frames at the
 * sizes that matter, each a real scrollable viewport rather than a screenshot.
 * The frames load the page with ?embed=1 so the preview bar is not inside
 * them; what you scroll is what a phone gets.
 */

import { useState } from 'react';
import type { LangId } from '@/components/home/data';

const DEVICES = [
  { id: 'iphone', name: 'iPhone 15', w: 393, h: 852, island: true },
  { id: 'se', name: 'iPhone SE', w: 375, h: 667, island: false },
  { id: 'android', name: 'Android (small)', w: 360, h: 800, island: false },
  { id: 'max', name: 'iPhone 15 Pro Max', w: 430, h: 932, island: true },
] as const;

const LANDSCAPE = { id: 'land', name: 'iPhone 15, landscape', w: 852, h: 393 };

/** Height of the status bar drawn above the page, as on a real phone. */
const STATUS = (island: boolean) => (island ? 54 : 24);

const SCALES = [0.6, 0.75, 1] as const;

export default function MobileMockups({ lang }: { lang: LangId | null }) {
  const [scale, setScale] = useState<(typeof SCALES)[number]>(0.75);
  const src = `/landing-lab?v=2&embed=1${lang ? `&lang=${lang}` : ''}`;

  return (
    <div className="mm">
      <div className="mm-bar">
        <p className="mm-note">
          V2 Simple, live in each frame. Scroll inside a phone; tap anything. The language you pick in a frame stays in that frame.
        </p>
        <div className="mm-scale" role="group" aria-label="Zoom">
          {SCALES.map((s) => (
            <button key={s} type="button" className={s === scale ? 'on' : ''} onClick={() => setScale(s)}>
              {Math.round(s * 100)}%
            </button>
          ))}
        </div>
      </div>

      <div className="mm-row">
        {DEVICES.map((d) => (
          <Phone key={d.id} name={d.name} w={d.w} h={d.h} island={d.island} src={src} scale={scale} />
        ))}
      </div>
      <div className="mm-row">
        <Phone name={LANDSCAPE.name} w={LANDSCAPE.w} h={LANDSCAPE.h} island={false} landscape src={src} scale={scale} />
      </div>
    </div>
  );
}

export function Phone({ name, w, h, island, landscape = false, src, scale }: {
  name: string; w: number; h: number; island: boolean; landscape?: boolean; src: string; scale: number;
}) {
  const bezel = 12;
  const status = landscape ? 0 : STATUS(island);
  const outerW = w + bezel * 2;
  const outerH = h + bezel * 2;
  return (
    <figure className="mm-device" style={{ width: outerW * scale }}>
      <div style={{ width: outerW * scale, height: outerH * scale }}>
        <div
          className={`mm-frame${landscape ? ' land' : ''}`}
          style={{ width: outerW, height: outerH, padding: bezel, transform: `scale(${scale})` }}
        >
          <div className="mm-screen" style={{ width: w, height: h }}>
            {status > 0 && (
              <div className="mm-status" style={{ height: status }}>
                <span>9:41</span>
                {island && <span className="mm-island" aria-hidden />}
                <span className="mm-status-icons" aria-hidden>
                  <i /><i /><i />
                </span>
              </div>
            )}
            <iframe title={`${name} preview`} src={src} style={{ width: w, height: h - status }} />
            {island && !landscape && <span className="mm-home" aria-hidden />}
          </div>
        </div>
      </div>
      <figcaption>{name} <span>{w}×{h}</span></figcaption>
    </figure>
  );
}
