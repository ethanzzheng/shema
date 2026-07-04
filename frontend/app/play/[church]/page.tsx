import Link from 'next/link';
import { normalizeChurchSlug } from '@/lib/slug';

// Kiosk output for a single device plugged into the church's sound system.
// Placeholder — the full-screen auto-play player lands in Step 6.
export default function PlayChurchPage({ params }: { params: { church: string } }) {
  const church = normalizeChurchSlug(decodeURIComponent(params.church));
  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: '4rem 1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <h1 style={{ fontSize: '1.65rem', fontWeight: 600 }}>Kiosk — {church}</h1>
      <div className="card" style={{ padding: '1.5rem' }}>
        <p style={{ color: 'var(--text-muted)' }}>
          The single-device kiosk player (auto-play, screen-wake, test tone) is coming soon.
          Until then, use the listener page for this church:
        </p>
        <p style={{ marginTop: '1rem' }}>
          <Link href={`/listen/${church}`} className="btn btn-primary">Open Listener</Link>
        </p>
      </div>
    </div>
  );
}
