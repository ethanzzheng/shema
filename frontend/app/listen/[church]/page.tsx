import type { Metadata } from 'next';
import ListenerView from '@/components/ListenerView';
import { normalizeChurchSlug, churchDisplayName } from '@/lib/slug';

/**
 * Per-church title and link preview. This is the link that actually gets sent
 * around — texted, put behind a QR, pasted into a church group chat — so it
 * should announce the church, not the product. The slug drives it, so every
 * tenant gets this without a code change. The homepage keeps the generic title
 * from app/layout.tsx.
 */
export function generateMetadata({ params }: { params: { church: string } }): Metadata {
  const slug = normalizeChurchSlug(decodeURIComponent(params.church));
  const name = churchDisplayName(slug);
  const title = name ? `${name} — Live Translation` : 'Shema — Live Translation';
  const description = name
    ? `Live translation of the service at ${name}. Open on your phone, headphones in — no app and no account.`
    : 'Live sermon translation. Open on your phone, headphones in — no app and no account.';

  return {
    title,
    description,
    // Explicit, because the shared link's preview card is the whole point.
    openGraph: { title, description, type: 'website' },
    twitter: { card: 'summary', title, description },
  };
}

// The QR-code link congregants land on: /listen/<church-slug>.
export default function ListenChurchPage({ params }: { params: { church: string } }) {
  return <ListenerView church={normalizeChurchSlug(decodeURIComponent(params.church))} />;
}
