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
        return;
      }
      // Playback health from a listener's own player. `replays` is the
      // stutter the pilot reported — the playhead moving back into audio
      // already heard. Nothing counted it in a live service before this, so a
      // regression could only surface as someone in the pews mentioning it.
      // Logged only when something actually went wrong; a clean listener is
      // silent.
      if (msg.type === 'playback_stats' && typeof msg.secondsPlayed === 'number') {
        const {
          replays = 0,
          underruns = 0,
          padsAppended = 0,
          secondsPlayed,
          leadIns = 0,
          fillRecoveries = 0,
          padSupported = true,
        } = msg;
        // padSupported false means the device rejected a silence pad and the
        // fill is off for that listener's whole session; fillRecoveries counts
        // clips whose audio_end never arrived. Either one leaves a sentence
        // starting on a drained buffer, which is heard as the first word being
        // cut off — so both are worth a line even when nothing else looks wrong.
        if (replays > 0 || underruns > 2 || fillRecoveries > 0 || !padSupported) {
          console.log(
            `[Playback] room "${session.roomId}": ${replays} replay(s), ${underruns} underrun(s), ` +
              `${padsAppended} pad(s), ${leadIns} lead-in(s), ${fillRecoveries} fill recovery(ies)` +
              `${padSupported ? '' : ', PAD UNSUPPORTED (fill disabled)'} over ${secondsPlayed}s of audio`,
          );
        }
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
