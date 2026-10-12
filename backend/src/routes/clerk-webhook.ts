/**
 * Clerk webhook — user.created.
 *
 * A demo signup is the warmest lead this product will ever get: somebody who
 * heard their own voice translated and then chose to sign in. This endpoint
 * is the hand-off point to a CRM; for now it records the signup and logs it.
 *
 * Signature verification is required. The endpoint is public, so without it
 * anyone could post fabricated signups into the lead list.
 */

import { Router, raw } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { recordEvent } from '../demo/events';

/**
 * Svix signature check, which is what Clerk uses. The secret is
 * `whsec_<base64>`; the signed payload is `<id>.<timestamp>.<body>`, and the
 * header can carry several space-separated versioned signatures.
 */
function verifySvix(secret: string, headers: Record<string, string | undefined>, body: Buffer): boolean {
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signature = headers['svix-signature'];
  if (!id || !timestamp || !signature) return false;

  // Reject anything old enough to be a replay.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${body.toString('utf8')}`)
    .digest('base64');

  for (const part of signature.split(' ')) {
    const provided = part.split(',')[1];
    if (!provided) continue;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export function createClerkWebhookRouter(): Router {
  const router = Router();

  // The raw body is required: a signature over a re-serialised JSON object
  // would not match what Clerk signed.
  router.post('/webhooks/clerk', raw({ type: 'application/json' }), (req, res) => {
    const secret = process.env.CLERK_WEBHOOK_SECRET;
    if (!secret) {
      console.warn('[Clerk] Webhook received but CLERK_WEBHOOK_SECRET is not set; ignoring.');
      res.status(503).json({ error: 'Webhook not configured' });
      return;
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifySvix(secret, req.headers as Record<string, string | undefined>, body)) {
      console.warn('[Clerk] Rejected a webhook with a bad signature.');
      res.status(401).json({ error: 'Bad signature' });
      return;
    }

    let payload: { type?: string; data?: Record<string, unknown> } = {};
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'Bad payload' });
      return;
    }

    if (payload.type === 'user.created') {
      const data = payload.data ?? {};
      const emails = Array.isArray(data.email_addresses) ? data.email_addresses : [];
      const email =
        emails.length > 0 && typeof (emails[0] as { email_address?: string }).email_address === 'string'
          ? (emails[0] as { email_address: string }).email_address
          : null;
      const userId = typeof data.id === 'string' ? data.id : null;

      // TODO: point this at the CRM. Until then the row is the lead list, and
      // `source` is what tells demo signups apart from anything added later.
      recordEvent({
        event: 'signed_in',
        clerkUserId: userId,
        meta: { source: 'demo', email, via: 'clerk.user.created' },
      });
      console.log(`[Clerk] Demo signup: ${email ?? userId ?? 'unknown'} (source=demo)`);
    }

    // Acknowledge anything else so Clerk stops retrying events we ignore.
    res.status(200).json({ received: true });
  });

  return router;
}
