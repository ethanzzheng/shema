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
import { login, authEnabled } from './auth';

// ── Validate required env vars at startup ─────────────────────────────────
const REQUIRED = ['ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'DEEPGRAM_API_KEY'];
const missing = REQUIRED.filter((k) => !process.env[k]);
// English voice: the per-direction var or the legacy one (kept as the
// backwards-compatible English default).
if (!process.env.ELEVENLABS_VOICE_ID_EN && !process.env.ELEVENLABS_VOICE_ID) {
  missing.push('ELEVENLABS_VOICE_ID (or ELEVENLABS_VOICE_ID_EN)');
}
if (missing.length) {
  console.error(`[Startup] Missing env vars: ${missing.join(', ')}`);
  console.error('Copy .env.example → .env and fill in your API keys.');
  process.exit(1);
}

// ── Origin allowlist ────────────────────────────────────────────────────────
// In production, browser clients (CORS + WS upgrades) must come from
// FRONTEND_URL (comma-separated origins, e.g. "https://tryshema.app,https://www.tryshema.app").
// In dev, or when FRONTEND_URL is unset, everything is allowed. Requests with
// no Origin header (curl, health probes, server-to-server) always pass —
// origin checks only defend against cross-site browser pages.
const IS_PROD = process.env.NODE_ENV === 'production';
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL ?? '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

function originAllowed(origin: string | undefined): boolean {
  if (!IS_PROD || ALLOWED_ORIGINS.length === 0) return true;
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, ''));
}

// ── App setup ──────────────────────────────────────────────────────────────
const app = express();

app.use(
  cors({
    origin: IS_PROD && ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : '*',
    methods: ['GET', 'POST', 'OPTIONS'],
  }),
);

app.use(express.json());

const sessions = new SessionManager();

// Health / status endpoint (polled by frontend connection check)
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    // Lets the frontend know whether to gate staff pages behind /login
    // (false in open dev mode, true when AUTH_USERS/AUTH_SECRET are set).
    authRequired: authEnabled(),
    rooms: sessions.roomCount,
    listenerCount: sessions.totalListeners,
    roomDetails: sessions.stats(),
    uptime: Math.floor(process.uptime()),
  });
});

// Staff login: username/password from AUTH_USERS → 12h session JWT.
// The token is what authorizes starting a broadcast (checked on the WS).
app.post('/login', (req, res) => {
  if (!authEnabled()) {
    res.status(503).json({ error: 'Login is not configured on this server.' });
    return;
  }
  const { username, password } = req.body ?? {};
  const token = login(username, password);
  if (!token) {
    console.warn('[Auth] Failed login attempt for user:', typeof username === 'string' ? username : '?');
    res.status(401).json({ error: 'Invalid username or password.' });
    return;
  }
  console.log('[Auth] Login OK:', username);
  res.json({ token, username });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) {
    console.warn('[Server] Rejected WS from disallowed origin:', origin);
    ws.close(1008, 'Origin not allowed');
    return;
  }

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
