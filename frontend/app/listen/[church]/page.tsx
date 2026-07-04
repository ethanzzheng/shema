import ListenerView from '@/components/ListenerView';
import { normalizeChurchSlug } from '@/lib/slug';

// The QR-code link congregants land on: /listen/<church-slug>.
export default function ListenChurchPage({ params }: { params: { church: string } }) {
  return <ListenerView church={normalizeChurchSlug(decodeURIComponent(params.church))} />;
}
