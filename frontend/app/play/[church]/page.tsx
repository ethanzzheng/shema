import KioskView from '@/components/KioskView';
import { normalizeChurchSlug } from '@/lib/slug';

// Single-device kiosk output: one laptop plugged into the church's receiver
// system via headphone/line-out. See components/KioskView.tsx.
export default function PlayChurchPage({ params }: { params: { church: string } }) {
  return <KioskView church={normalizeChurchSlug(decodeURIComponent(params.church))} />;
}
