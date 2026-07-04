/**
 * Shema — Backend Entry Point
 *
 * Express HTTP server + WebSocket server (ws library).
 * WebSocket connections join a room and take a role:
 *   ?room=<church-slug>&role=broadcaster → mic audio in, transcripts/translations out
 *   ?room=<church-slug>&role=listener    → translation text + audio out
 * `room` defaults to "default" when absent, so pre-rooms clients still work.
 */

import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { SessionManager, normalizeRoomId } from './session-manager';
import { handleBroadcasterConnection } from './broadcaster';
import { handleListenerConnection } from './listener';

// ── Validate required env vars at startup ─────────────────────────────────
const REQUIRED = ['ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'DEEPGRAM_API_KEY'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`[Startup] Missing env vars: ${missing.join(', ')}`);
  console.error('Copy .env.example → .env and fill in your API keys.');
  process.exit(1);
}

// ── App setup ──────────────────────────────────────────────────────────────
const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? '*',
    methods: ['GET', 'POST', 'OPTIONS'],
  }),
);

app.use(express.json());

const sessions = new SessionManager();

// Health / status endpoint (polled by frontend connection check)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    rooms: sessions.roomCount,
    listenerCount: sessions.totalListeners,
    roomDetails: sessions.stats(),
    uptime: Math.floor(process.uptime()),
  });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  let role: string | null = null;
  let roomId: string;
  try {
    const urlObj = new URL(req.url ?? '', `http://localhost`);
    role = urlObj.searchParams.get('role');
    roomId = normalizeRoomId(urlObj.searchParams.get('room'));
  } catch {
    ws.close(1008, 'Bad URL');
    return;
  }

  if (role !== 'broadcaster' && role !== 'listener') {
    console.warn('[Server] Unknown role:', role);
    ws.close(1008, 'Unknown role — use ?role=broadcaster or ?role=listener');
    return;
  }

  const session = sessions.getOrCreate(roomId);
  if (role === 'broadcaster') {
    handleBroadcasterConnection(ws, session);
  } else {
    handleListenerConnection(ws, session);
  }

  // Registered AFTER the handlers above, so their own close handlers (which
  // remove the socket from the session) have already run by the time this
  // emptiness check fires.
  ws.on('close', () => sessions.maybeCleanup(roomId));
});

const PORT = parseInt(process.env.PORT ?? '3001', 10);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎙️  Shema backend running on port ${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws?role=broadcaster|listener`);
  console.log(`   Health:    http://localhost:${PORT}/health\n`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, shutting down');
  server.close(() => process.exit(0));
});
