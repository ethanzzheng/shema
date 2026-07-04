/**
 * Church slug normalization — mirrors the backend's normalizeRoomId so the
 * slug shown in links/QRs is exactly the room the WebSocket lands in.
 * "Grace Church" → "grace-church"; empty/garbage → "default".
 */
export function normalizeChurchSlug(raw: string | null | undefined): string {
  const slug = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'default';
}
