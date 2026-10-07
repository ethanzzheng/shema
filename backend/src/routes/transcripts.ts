/**
 * Transcript REST API.
 *
 * Read-mostly: the live pipeline writes through TranscriptWriter, and these
 * routes exist so a church can find, read, export and delete what was kept.
 */

import { Router, Request, Response } from 'express';
import { authEnabled, verifyToken } from '../auth';
import { isDbConfigured } from '../db';
import { normalizeRoomId } from '../session-manager';
import * as repo from '../transcripts/repo';

/** Same posture as the glossary routes: open dev mode allows everything. */
function authorize(req: Request, res: Response): boolean {
  if (!authEnabled()) return true;
  const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (verifyToken(token)) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

function requireDb(res: Response): boolean {
  if (isDbConfigured()) return true;
  res.status(503).json({ error: 'No transcript database is configured on this server.' });
  return false;
}

export function createTranscriptRouter(): Router {
  const router = Router();

  // List. Deliberately carries no segments: a church with a year of services
  // would otherwise pull every line of every sermon to render a page of dates.
  router.get('/transcripts', async (req, res) => {
    if (!authorize(req, res) || !requireDb(res)) return;
    const churchId = normalizeRoomId(String(req.query.church ?? ''));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    try {
      res.json({ transcripts: await repo.listTranscripts(churchId, limit, offset) });
    } catch (err) {
      res.status(502).json({ error: `Could not load transcripts: ${(err as Error).message}` });
    }
  });

  router.get('/transcripts/:id', async (req, res) => {
    if (!authorize(req, res) || !requireDb(res)) return;
    try {
      const transcript = await repo.getTranscript(req.params.id);
      if (!transcript) {
        res.status(404).json({ error: 'No such transcript' });
        return;
      }
      res.json({ transcript, segments: await repo.getSegments(transcript.id) });
    } catch (err) {
      res.status(502).json({ error: `Could not load transcript: ${(err as Error).message}` });
    }
  });

  // Hard delete, and it cascades. Services carry testimonies and prayer
  // requests; "removed" has to mean removed.
  router.delete('/transcripts/:id', async (req, res) => {
    if (!authorize(req, res) || !requireDb(res)) return;
    try {
      const ok = await repo.deleteTranscript(req.params.id);
      if (!ok) {
        res.status(404).json({ error: 'No such transcript' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: `Could not delete: ${(err as Error).message}` });
    }
  });

  return router;
}
