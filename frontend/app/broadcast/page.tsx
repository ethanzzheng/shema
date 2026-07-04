'use client';

// Legacy route — the broadcaster moved to /speak. Preserve any query
// (?room=/?church=) so old bookmarks land in the right room.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LegacyBroadcastRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/speak${window.location.search}`);
  }, [router]);
  return null;
}
