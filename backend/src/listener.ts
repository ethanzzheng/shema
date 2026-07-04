/**
 * Handles listener WebSocket connections. Each listener joins ONE room's
 * Session; translation text + audio reach it via session.broadcast(), so
 * fan-out never crosses rooms.
 *
 * Messages to listeners:
 *   { type: "status", active: boolean }
 *   { type: "translation", seq, direct, sermon, timestamp }
 *   { type: "audio_start" | "audio_chunk" | "audio_end", seq, ... }
 */

import { WebSocket } from 'ws';
import { Session } from './session';

function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function handleListenerConnection(ws: WebSocket, session: Session): void {
  console.log(`[Listener] New connection (room "${session.roomId}", ${session.listenerCount + 1} listening)`);
  session.addListener(ws);

  // Immediately inform the new listener of current broadcast state
  safeSend(ws, { type: 'status', active: session.isActive });

  ws.on('close', () => {
    console.log(`[Listener] Disconnected (room "${session.roomId}")`);
    session.removeListener(ws);
  });

  ws.on('error', (err) => {
    console.error(`[Listener] WS error (room "${session.roomId}"):`, err.message);
    session.removeListener(ws);
  });
}
