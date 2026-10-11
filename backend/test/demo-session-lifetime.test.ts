/**
 * A demo must survive losing its sockets, because the soft wall asks the
 * prospect to go and sign in — on a phone that means leaving the page.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SessionManager } from '../src/session-manager';

function demoRoom(sessions: SessionManager, id: string, ttlMs: number) {
  const session = sessions.getOrCreate(id);
  session.demo = {
    clerkUserId: null,
    ttsAllowed: true,
    ttsChars: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };
  return session;
}

test('an unexpired demo survives its last socket closing', () => {
  const sessions = new SessionManager();
  demoRoom(sessions, 'demo-abc', 60_000);

  sessions.maybeCleanup('demo-abc');

  assert.ok(
    sessions.get('demo-abc'),
    'demo was reclaimed on disconnect — signing in after would 404',
  );
});

test('the demo is still collected once it expires', () => {
  const sessions = new SessionManager();
  demoRoom(sessions, 'demo-old', -1_000); // already past its deadline

  sessions.maybeCleanup('demo-old');

  assert.equal(sessions.get('demo-old'), undefined, 'expired demo should not linger');
});

test('an expired demo left open is reaped on the sweep', () => {
  const sessions = new SessionManager();
  demoRoom(sessions, 'demo-walkaway', -1);

  assert.equal(sessions.reapExpiredDemos(), 1);
  assert.equal(sessions.get('demo-walkaway'), undefined);
});

test('a church room is still reclaimed the moment it empties', () => {
  const sessions = new SessionManager();
  sessions.getOrCreate('hanmaum');

  sessions.maybeCleanup('hanmaum');

  assert.equal(sessions.get('hanmaum'), undefined, 'non-demo rooms must not be kept alive');
});
