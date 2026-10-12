/**
 * Clerk verification.
 *
 * Only the secret key touches this process; it is read from the environment
 * and never logged. A demo's TTS allowance is tied to the verified Clerk user
 * id, so a forged token would be a forged allowance — the token is verified
 * against Clerk rather than merely decoded.
 */

import { verifyToken } from '@clerk/backend';

export function clerkConfigured(): boolean {
  return Boolean(process.env.CLERK_SECRET_KEY);
}

/** Verified Clerk user id, or null. Never throws. */
export async function clerkUserIdFrom(authorization: string | undefined): Promise<string | null> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return null;
  const token = String(authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const payload = await verifyToken(token, { secretKey });
    return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
  } catch {
    // Expired, malformed, or signed by someone else. All the same answer.
    return null;
  }
}
