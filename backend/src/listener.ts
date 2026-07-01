/**
 * Handles listener WebSocket connections and provides a broadcast function
 * used by the broadcaster pipeline to push translation text + audio.
 *
 * Messages to listeners:
 *   { type: "status", active: boolean }
 *   { type: "translation", seq, direct, sermon, timestamp }
 *   { type: "audio", seq, data: base64, format: "mp3" }
 */

import { WebSocket } from 'ws';

// Global registry of active listener sockets
const listeners = new Set<WebSocket>();

function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function handleListenerConnection(ws: WebSocket, session: { isActive: boolean }): void {
  console.log('[Listener] New connection');
  listeners.add(ws);

  // Immediately inform the new listener of current broadcast state
  safeSend(ws, { type: 'status', active: session.isActive });

  ws.on('close', () => {
    console.log('[Listener] Disconnected');
    listeners.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('[Listener] WS error:', err.message);
    listeners.delete(ws);
  });
}

/**
 * Broadcast a JSON payload to all connected listeners.
 * Stale (closed) sockets are removed automatically.
 */
export function broadcastToListeners(payload: unknown): void {
  const msg = JSON.stringify(payload);
  for (const ws of listeners) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    } else {
      listeners.delete(ws);
    }
  }
}

export function listenerCount(): number {
  return listeners.size;
}
