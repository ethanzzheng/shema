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

/**
 * Slug → human church name for page titles and link previews:
 * "grace-church" → "Grace Church". "default" has no church behind it (the
 * generic /listen entry), so it yields '' and callers fall back to the plain
 * product title rather than announcing a church named "Default".
 */
export function churchDisplayName(slug: string | null | undefined): string {
  const s = (slug ?? '').trim();
  if (!s || s === 'default') return '';
  return s
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
