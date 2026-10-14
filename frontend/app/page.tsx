'use client';

/**
 * Marketing homepage. The design lives in components/home/HomeV2 (built and
 * compared in the landing lab, which renders the same component); this page
 * only owns its state: which language the visitor picked, which way the hero
 * card translates, and the caption cycle that fills it.
 *
 * Forms POST /api/contact (Next rewrite → contact Worker), the same contract
 * and subjects as the previous homepage.
 */

import { useRef, useState } from 'react';
import HomeV2 from '@/components/home/HomeV2';
import type { LangId } from '@/components/home/data';
import { useHeroCycle, useReducedMotion } from '@/components/home/shared';

export default function MarketingPage() {
  const [selected, setSelected] = useState<LangId | null>(null);
  const [flip, setFlip] = useState(false);
  const reduced = useReducedMotion();
  const holdRef = useRef(false);
  const hero = useHeroCycle(selected, reduced, holdRef, flip);
  return (
    <HomeV2
      selected={selected}
      onSelect={setSelected}
      hero={hero}
      holdRef={holdRef}
      reduced={reduced}
      flip={flip}
      setFlip={setFlip}
    />
  );
}
