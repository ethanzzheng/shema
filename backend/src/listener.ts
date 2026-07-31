/**
 * Handles listener WebSocket connections. Each listener joins ONE room's
 * Session; translation text + audio reach it via session.broadcast(), so
 * fan-out never crosses rooms.
 *
 * Messages to listeners:
 *   { type: "status", active: boolean }
 *   { type: "transcript_history", chunks: [{ seq, direct, sermon, timestamp }] }
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
  // (direction tells the UI which output language to label).
  safeSend(ws, { type: 'status', active: session.isActive, direction: session.direction });

  // Send the full transcript so far, so late-joiners and refreshes see the
  // whole sermon (text only — audio is live from the join point on).
  safeSend(ws, { type: 'transcript_history', chunks: session.transcriptForListeners() });

  // Listeners report which seq their audio is actually playing (throttled
  // client-side); the broadcaster desk shows where the pews are.
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse((data as Buffer).toString());
      if (msg.type === 'playing' && typeof msg.seq === 'number') {
        session.recordListenerProgress(ws, msg.seq);
        const pews = session.pewsSeq;
        if (pews !== null) session.sendToBroadcasters({ type: 'pews', seq: pews });
      }
    } catch {
      /* listeners send nothing else; ignore malformed frames */
    }
  });

  ws.on('close', () => {
    console.log(`[Listener] Disconnected (room "${session.roomId}")`);
    session.removeListener(ws);
  });

  ws.on('error', (err) => {
    console.error(`[Listener] WS error (room "${session.roomId}"):`, err.message);
    session.removeListener(ws);
  });
}
