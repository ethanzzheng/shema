/**
 * Rooms: per-room fan-out isolation + lifecycle cleanup.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { WebSocket } from 'ws';
import { SessionManager, normalizeRoomId } from '../src/session-manager';

/** Minimal stand-in for an open ws socket that records what it was sent. */
function fakeSocket(): { sent: string[] } & Pick<WebSocket, 'readyState' | 'send'> {
  const sock = {
    sent: [] as string[],
    readyState: WebSocket.OPEN,
    send(msg: string) {
      sock.sent.push(msg);
    },
  };
  return sock as any;
}

describe('normalizeRoomId', () => {
  test('defaults to "default" when absent or empty', () => {
    assert.equal(normalizeRoomId(null), 'default');
    assert.equal(normalizeRoomId(undefined), 'default');
    assert.equal(normalizeRoomId(''), 'default');
    assert.equal(normalizeRoomId('!!!'), 'default');
  });

  test('normalizes to lowercase kebab-case', () => {
    assert.equal(normalizeRoomId('Grace Church'), 'grace-church');
    assert.equal(normalizeRoomId('grace-church'), 'grace-church');
    assert.equal(normalizeRoomId('  A/B  '), 'a-b');
  });
});

describe('SessionManager', () => {
  test('same roomId returns the same session; different roomIds differ', () => {
    const mgr = new SessionManager();
    const a1 = mgr.getOrCreate('a');
    const a2 = mgr.getOrCreate('a');
    const b = mgr.getOrCreate('b');
    assert.equal(a1, a2);
    assert.notEqual(a1, b);
    assert.equal(mgr.roomCount, 2);
  });

  test('broadcast reaches only the room it was sent to', () => {
    const mgr = new SessionManager();
    const roomA = mgr.getOrCreate('a');
    const roomB = mgr.getOrCreate('b');

    const listenerA = fakeSocket();
    const listenerB = fakeSocket();
    roomA.addListener(listenerA as any);
    roomB.addListener(listenerB as any);

    roomA.broadcast({ type: 'translation', sermon: 'only for A' });

    assert.equal(listenerA.sent.length, 1);
    assert.match(listenerA.sent[0], /only for A/);
    assert.equal(listenerB.sent.length, 0, 'room B listener must receive nothing');
  });

  test('closed sockets are pruned on broadcast', () => {
    const mgr = new SessionManager();
    const room = mgr.getOrCreate('a');
    const open = fakeSocket();
    const closed = fakeSocket();
    (closed as any).readyState = WebSocket.CLOSED;
    room.addListener(open as any);
    room.addListener(closed as any);

    room.broadcast({ type: 'status', active: true });

    assert.equal(open.sent.length, 1);
    assert.equal(closed.sent.length, 0);
    assert.equal(room.listenerCount, 1);
  });

  test('room is reclaimed only when broadcaster AND listeners are gone', () => {
    const mgr = new SessionManager();
    const room = mgr.getOrCreate('a');
    const broadcaster = fakeSocket();
    const listener = fakeSocket();
    room.addBroadcaster(broadcaster as any);
    room.addListener(listener as any);

    // Broadcaster leaves, a listener remains → room survives
    room.removeBroadcaster(broadcaster as any);
    mgr.maybeCleanup('a');
    assert.equal(mgr.get('a'), room);

    // Last listener leaves → room reclaimed
    room.removeListener(listener as any);
    mgr.maybeCleanup('a');
    assert.equal(mgr.get('a'), undefined);
    assert.equal(mgr.roomCount, 0);
  });

  test('broadcasters are told the listener count as it changes', () => {
    const mgr = new SessionManager();
    const room = mgr.getOrCreate('a');
    const broadcaster = fakeSocket();
    room.addBroadcaster(broadcaster as any);
    // Initial count on join
    assert.match(broadcaster.sent[0], /"type":"listeners".*"count":0/);

    const listener = fakeSocket();
    room.addListener(listener as any);
    assert.match(broadcaster.sent[1], /"count":1/);

    room.removeListener(listener as any);
    assert.match(broadcaster.sent[2], /"count":0/);
    // Removing a socket that was never added notifies nobody
    room.removeListener(fakeSocket() as any);
    assert.equal(broadcaster.sent.length, 3);
  });

  test('transcript keeps the full broadcast (no truncation) and clears on demand', () => {
    const mgr = new SessionManager();
    const room = mgr.getOrCreate('a');
    for (let i = 1; i <= 120; i++) {
      room.addTranslation({ seq: i, korean: `k${i}`, direct: `d${i}`, sermon: `s${i}`, timestamp: i });
    }
    assert.equal(room.translationHistory.length, 120); // old cap was 50

    const wire = room.transcriptForListeners();
    assert.equal(wire.length, 120);
    assert.deepEqual(wire[0], { seq: 1, direct: 'd1', sermon: 's1', timestamp: 1 });
    assert.ok(!('korean' in wire[0]), 'Korean payload must not go to listeners');

    room.clearTranscript();
    assert.equal(room.translationHistory.length, 0);
  });

  test('pews progress: most-behind listener wins; leavers and strangers ignored', () => {
    const mgr = new SessionManager();
    const room = mgr.getOrCreate('a');
    const a = fakeSocket();
    const b = fakeSocket();
    room.addListener(a as any);
    room.addListener(b as any);

    assert.equal(room.pewsSeq, null);
    room.recordListenerProgress(a as any, 5);
    room.recordListenerProgress(b as any, 3);
    assert.equal(room.pewsSeq, 3, 'the most-behind listener defines the pews');

    // A socket that is not a listener in this room cannot report.
    room.recordListenerProgress(fakeSocket() as any, 1);
    assert.equal(room.pewsSeq, 3);

    // When the behind listener leaves, the pews advance.
    room.removeListener(b as any);
    assert.equal(room.pewsSeq, 5);

    // Broadcasters receive pushed payloads via sendToBroadcasters.
    const desk = fakeSocket();
    room.addBroadcaster(desk as any);
    room.sendToBroadcasters({ type: 'pews', seq: 5 });
    assert.match(desk.sent[desk.sent.length - 1], /"type":"pews".*"seq":5/);
  });

  test('stats reports per-room listener counts', () => {
    const mgr = new SessionManager();
    const roomA = mgr.getOrCreate('a');
    mgr.getOrCreate('b');
    roomA.addListener(fakeSocket() as any);
    roomA.addListener(fakeSocket() as any);
    roomA.isActive = true;

    assert.deepEqual(mgr.stats(), {
      a: { listeners: 2, broadcasting: true, direction: 'ko-en' },
      b: { listeners: 0, broadcasting: false, direction: 'ko-en' },
    });
    assert.equal(mgr.totalListeners, 2);
  });
});
