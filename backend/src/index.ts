/**
 * Shema — Backend Entry Point
 *
 * Express HTTP server + WebSocket server (ws library).
 * WebSocket roles:
 *   ?role=broadcaster → mic audio in, transcripts/translations out
 *   ?role=listener    → translation text + audio out
 */

import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { Session } from './session';
import { handleBroadcasterConnection } from './broadcaster';
import { handleListenerConnection, listenerCount } from './listener';

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

// Health / status endpoint (polled by frontend connection check)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    listenerCount: listenerCount(),
    uptime: Math.floor(process.uptime()),
  });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const session = new Session();

wss.on('connection', (ws, req) => {
  let role: string | null = null;
  try {
    const urlObj = new URL(req.url ?? '', `http://localhost`);
    role = urlObj.searchParams.get('role');
  } catch {
    ws.close(1008, 'Bad URL');
    return;
  }

  if (role === 'broadcaster') {
    handleBroadcasterConnection(ws, session);
  } else if (role === 'listener') {
    handleListenerConnection(ws, session);
  } else {
    console.warn('[Server] Unknown role:', role);
    ws.close(1008, 'Unknown role — use ?role=broadcaster or ?role=listener');
  }
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
