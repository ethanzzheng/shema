/**
 * Demo funnel API.
 *
 * Public and unauthenticated by design — a cold-email recipient must be able
 * to try the product before trusting it with anything. Every endpoint here is
 * therefore written defensively.
 */

import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { SessionManager } from '../session-manager';
import { DEMO_PREFIX, demoConfig, isDemoRoom, perAccountCharCap } from '../demo/config';
import { mayStartAnonDemo, remainingForAccount } from '../demo/budget';
import { clerkConfigured, clerkUserIdFrom } from '../demo/auth';
import { isDemoEvent, recordEvent } from '../demo/events';

/**
 * The address the request really came from. Railway and Vercel both sit behind
 * proxies, so the socket address is a load balancer; without the forwarded
 * header the per-IP throttle would see one client.
 */
function clientIp(req: Request): string {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

export function createDemoRouter(sessions: SessionManager): Router {
  const router = Router();

  /** Limits, so the UI counts down with the same numbers the server enforces. */
  router.get('/demo/config', (_req, res) => {
    res.json({
      requireSignIn: demoConfig.requireSignIn(),
      anonSeconds: demoConfig.anonSeconds(),
      anonSegments: demoConfig.anonSegments(),
      ttsSecondsPerAccount: demoConfig.ttsSecondsPerAccount(),
      sessionTtlSeconds: demoConfig.sessionTtlSeconds(),
      clerkEnabled: clerkConfigured(),
    });
  });

  /**
   * Start an anonymous demo. Returns a room in the demo namespace that the
   * browser then joins over the normal broadcaster socket, so the demo runs
   * through the real pipeline rather than a mock of it.
   */
  router.post('/demo/session', async (req, res) => {
    const ip = clientIp(req);
    if (!mayStartAnonDemo(ip)) {
      res.status(429).json({
        error: 'Too many demos started from this connection. Try again in a little while.',
      });
      return;
    }

    // Short, unguessable, and inside the namespace so nothing downstream can
    // confuse it with a church. Not sequential: a guessable id would let
    // someone join a stranger's demo.
    const roomId = `${DEMO_PREFIX}${randomBytes(6).toString('hex')}`;
    const session = sessions.getOrCreate(roomId);
    const ttlMs = demoConfig.sessionTtlSeconds() * 1000;
    session.demo = {
      clerkUserId: null,
      // The real voice, bounded. Server-side caps decide when it stops.
      ttsAllowed: true,
      ttsChars: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };

    recordEvent({ event: 'page_view', sessionId: roomId, meta: { ip: ip.slice(0, 45) } });
    res.status(201).json({
      room: roomId,
      ttsAllowed: true,
      // Without a wall there is nothing to trade for the listener link, and it
      // is the part that convinces people — hand it over immediately.
      listenPath: demoConfig.requireSignIn() ? null : `/listen/${roomId}`,
      anonTtsSeconds: demoConfig.anonTtsSeconds(),
      anonSeconds: demoConfig.anonSeconds(),
      anonSegments: demoConfig.anonSegments(),
      expiresAt: session.demo.expiresAt,
    });
  });

  /**
   * Trade a verified Clerk token for speech on an existing demo room. This is
   * the soft wall being passed, and it is the only way ttsAllowed ever becomes
   * true — the client cannot set it.
   */
  router.post('/demo/session/:room/upgrade', async (req, res) => {
    const roomId = String(req.params.room);
    if (!isDemoRoom(roomId)) {
      res.status(400).json({ error: 'Not a demo session.' });
      return;
    }
    const session = sessions.get(roomId);
    if (!session?.demo) {
      res.status(404).json({ error: 'This demo has expired. Start a new one.' });
      return;
    }
    const userId = await clerkUserIdFrom(req.headers.authorization);
    if (!userId) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }

    const remaining = await remainingForAccount(userId);
    session.demo.clerkUserId = userId;
    session.demo.ttsAllowed = remaining > 0;
    // The wall is where a prospect commits, so the funnel lives or dies here.
    recordEvent({ event: 'signed_in', sessionId: roomId, clerkUserId: userId });

    res.json({
      ttsAllowed: session.demo.ttsAllowed,
      remainingChars: remaining,
      totalChars: perAccountCharCap(),
      // The listener link is the moment the prospect hears it on their own
      // phone, which is the part of the demo that actually sells.
      listenPath: `/listen/${roomId}`,
    });
  });

  /**
   * Funnel events from the browser. Unauthenticated, so the event name is
   * checked against a list rather than trusted, and the payload is bounded.
   */
  router.post('/demo/event', async (req, res) => {
    const body = req.body ?? {};
    if (!isDemoEvent(body.event)) {
      res.status(400).json({ error: 'Unknown event' });
      return;
    }
    const sessionId = typeof body.room === 'string' && isDemoRoom(body.room) ? body.room : null;
    const userId = await clerkUserIdFrom(req.headers.authorization);
    const meta =
      body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)
        ? Object.fromEntries(Object.entries(body.meta as object).slice(0, 10))
        : {};
    recordEvent({ event: body.event, sessionId, clerkUserId: userId, meta });
    res.status(202).json({ ok: true });
  });

  return router;
}
