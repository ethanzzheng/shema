/**
 * Glossary REST API, used by both the broadcast desk and the management page.
 *
 * Writes do two things beyond persisting: they update the in-memory cache for
 * a live room, so a term is in force for the next sentence without the pipeline
 * ever re-reading the database, and they push the new list to that room's
 * broadcasters so a change made on the management page shows up at the desk.
 */

import { Router, Request, Response } from 'express';
import { authEnabled, verifyToken } from '../auth';
import { isDbConfigured } from '../db';
import { normalizeRoomId, SessionManager } from '../session-manager';
import * as repo from '../glossary/repo';
import { isBehavior, GlossaryTerm } from '../glossary/types';

/**
 * Same posture as the broadcaster's start check: when no auth is configured
 * the server is in open dev mode and everything is allowed. Once AUTH_SECRET
 * and AUTH_USERS exist, a valid token is required.
 */
function authorize(req: Request, res: Response): boolean {
  if (!authEnabled()) return true;
  const header = String(req.headers.authorization ?? '');
  const token = header.replace(/^Bearer\s+/i, '');
  if (verifyToken(token)) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

function requireDb(res: Response): boolean {
  if (isDbConfigured()) return true;
  res.status(503).json({
    error: 'No glossary database is configured. Terms are read-only from CHURCH_GLOSSARY.',
  });
  return false;
}

function actor(req: Request): string | null {
  const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return verifyToken(token);
}

export function createGlossaryRouter(sessions: SessionManager): Router {
  const router = Router();

  /**
   * Apply a change to the live pipeline's cache, then tell the room's desks.
   *
   * The pushed list is read back from the database rather than taken from the
   * session cache. Off air that cache is empty — it is only filled at broadcast
   * start — so pushing it would wipe the desk's list the moment anyone added a
   * term before going live. Writes are rare, so the extra read costs nothing
   * that matters; the live pipeline still never reads the database per chunk.
   */
  async function syncRoom(
    churchId: string,
    mutate?: (s: NonNullable<ReturnType<SessionManager['get']>>) => void,
  ): Promise<void> {
    const session = sessions.get(churchId);
    if (session && mutate) mutate(session);
    if (!session) return;
    try {
      const church = await repo.listChurchTerms(churchId);
      const service = session.broadcastId ? await repo.listSessionTerms(session.broadcastId) : [];
      session.sendToBroadcasters({ type: 'glossary', terms: [...church, ...service] });
    } catch {
      /* The desk keeps what it has; the pipeline cache is already updated. */
    }
  }

  // Read. Church terms always; service terms for the live broadcast, and past
  // service terms for the management page's "promote" list.
  router.get('/glossary', async (req, res) => {
    if (!authorize(req, res)) return;
    const churchId = normalizeRoomId(String(req.query.church ?? ''));
    if (!isDbConfigured()) {
      const session = sessions.get(churchId);
      res.json({ source: 'env', church: session?.glossaryChurch ?? [], service: [], past: [] });
      return;
    }
    try {
      const session = sessions.get(churchId);
      const [church, past] = await Promise.all([
        repo.listChurchTerms(churchId),
        repo.listRecentSessionTerms(churchId),
      ]);
      const service = session?.broadcastId ? await repo.listSessionTerms(session.broadcastId) : [];
      res.json({ source: 'db', church, service, past });
    } catch (err) {
      res.status(502).json({ error: `Glossary unavailable: ${(err as Error).message}` });
    }
  });

  // Create. `serviceOnly` is the desk's default: terms scoped to this broadcast.
  router.post('/glossary', async (req, res) => {
    if (!authorize(req, res) || !requireDb(res)) return;
    const body = req.body ?? {};
    const churchId = normalizeRoomId(String(body.church ?? ''));
    const sourceTerm = String(body.sourceTerm ?? '').trim();
    if (!sourceTerm) {
      res.status(400).json({ error: 'sourceTerm is required' });
      return;
    }
    const behavior = isBehavior(body.behavior) ? body.behavior : 'translate';
    const targets =
      body.targets && typeof body.targets === 'object' ? (body.targets as Record<string, string>) : {};
    if (behavior === 'translate' && Object.values(targets).every((v) => !String(v ?? '').trim())) {
      res.status(400).json({ error: 'A translated term needs a rendering. Use behavior "keep" to leave it as-is.' });
      return;
    }

    // Service scope needs an id to hang off. Minting on demand lets an operator
    // stage terms before going on air rather than being told to start first.
    let sessionId: string | null = null;
    if (body.serviceOnly) {
      const session = sessions.getOrCreate(churchId);
      sessionId = session.ensureBroadcastId();
    }

    try {
      const term = await repo.addTerm({
        churchId,
        sessionId,
        sourceTerm,
        behavior,
        targets,
        notes: body.notes ? String(body.notes) : null,
        createdBy: actor(req),
      });
      if (!term) {
        res.status(409).json({ error: 'That term is already in the church glossary.' });
        return;
      }
      // Live tier whatever the scope: a church term added mid-broadcast must
      // not be folded into the cached system prompt until the next one.
      await syncRoom(churchId, (s) => s.addLiveTerm(term));
      res.status(201).json({ term });
    } catch (err) {
      res.status(502).json({ error: `Could not save: ${(err as Error).message}` });
    }
  });

  router.patch('/glossary/:id', async (req, res) => {
    if (!authorize(req, res) || !requireDb(res)) return;
    const body = req.body ?? {};
    const patch: Partial<Pick<GlossaryTerm, 'sourceTerm' | 'behavior' | 'targets' | 'notes'>> = {};
    if (body.sourceTerm !== undefined) patch.sourceTerm = String(body.sourceTerm);
    if (body.behavior !== undefined && isBehavior(body.behavior)) patch.behavior = body.behavior;
    if (body.targets !== undefined) patch.targets = body.targets as Record<string, string>;
    if (body.notes !== undefined) patch.notes = body.notes === null ? null : String(body.notes);
    try {
      const term = await repo.updateTerm(req.params.id, patch);
      if (!term) {
        res.status(404).json({ error: 'No such term' });
        return;
      }
      await syncRoom(term.churchId, (s) => s.addLiveTerm(term));
      res.json({ term });
    } catch (err) {
      res.status(502).json({ error: `Could not update: ${(err as Error).message}` });
    }
  });

  router.delete('/glossary/:id', async (req, res) => {
    if (!authorize(req, res) || !requireDb(res)) return;
    try {
      const existing = await repo.getTerm(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'No such term' });
        return;
      }
      await repo.deleteTerm(req.params.id);
      await syncRoom(existing.churchId, (s) => s.removeGlossaryTerm(existing.id));
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: `Could not delete: ${(err as Error).message}` });
    }
  });

  // Promote a service term into the permanent church glossary.
  router.post('/glossary/:id/promote', async (req, res) => {
    if (!authorize(req, res) || !requireDb(res)) return;
    try {
      const term = await repo.promoteTerm(req.params.id);
      if (!term) {
        res.status(404).json({ error: 'No such term' });
        return;
      }
      await syncRoom(term.churchId);
      res.json({ term });
    } catch (err) {
      res.status(502).json({ error: `Could not promote: ${(err as Error).message}` });
    }
  });

  return router;
}
