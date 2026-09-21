import type { Metadata } from 'next';
import KioskView from '@/components/KioskView';
import { normalizeChurchSlug, churchDisplayName } from '@/lib/slug';

// Titled per church for the same reason as /listen/[church]: this link gets
// sent to whoever is setting up the kiosk laptop, and an operator with several
// tabs open needs to tell them apart.
export function generateMetadata({ params }: { params: { church: string } }): Metadata {
  const name = churchDisplayName(normalizeChurchSlug(decodeURIComponent(params.church)));
  return { title: name ? `${name} — Kiosk Output` : 'Shema — Kiosk Output' };
}

// Single-device kiosk output: one laptop plugged into the church's receiver
// system via headphone/line-out. See components/KioskView.tsx.
export default function PlayChurchPage({ params }: { params: { church: string } }) {
  return <KioskView church={normalizeChurchSlug(decodeURIComponent(params.church))} />;
}
