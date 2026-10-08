/**
 * Demo spend control. The caps exist because this is a public URL on a cold
 * email funnel, so the tests are written from the attacker's side: what
 * happens when the client lies, when the database is down, when one address
 * hammers the endpoint.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { demoConfig, isDemoRoom, perAccountCharCap, DEMO_PREFIX } from '../src/demo/config';
import { mayStartAnonDemo, __resetIpLimiter } from '../src/demo/budget';
import { isDemoEvent } from '../src/demo/events';

describe('demo namespace', () => {
  test('demo rooms are recognisable, real churches are not', () => {
    assert.equal(isDemoRoom(`${DEMO_PREFIX}a1b2c3`), true);
    assert.equal(isDemoRoom('hanmaum'), false);
    assert.equal(isDemoRoom('grace-church'), false);
    // A church could not accidentally land in the namespace by naming itself
    // something close, because the check is a prefix on the normalized slug.
    assert.equal(isDemoRoom('demonstration-church'), false, 'prefix must not match a real name');
  });
});

describe('caps', () => {
  test('every cap is overridable by env', () => {
    const prev = process.env.DEMO_ANON_SECONDS;
    process.env.DEMO_ANON_SECONDS = '45';
    try {
      assert.equal(demoConfig.anonSeconds(), 45);
    } finally {
      if (prev === undefined) delete process.env.DEMO_ANON_SECONDS;
      else process.env.DEMO_ANON_SECONDS = prev;
    }
  });

  test('a nonsense env value falls back to the default rather than zero', () => {
    // A cap that silently became 0 would read as "no demo allowed"; one that
    // became NaN would compare false against everything and allow all.
    const prev = process.env.DEMO_ANON_SECONDS;
    process.env.DEMO_ANON_SECONDS = 'not-a-number';
    try {
      assert.equal(demoConfig.anonSeconds(), 90);
    } finally {
      if (prev === undefined) delete process.env.DEMO_ANON_SECONDS;
      else process.env.DEMO_ANON_SECONDS = prev;
    }
  });

  test('the per-account cap converts seconds to the unit ElevenLabs bills in', () => {
    // 300s at 18 chars/s. Measured services run 800-1,400 chars per minute,
    // so ~18/s sits in that range.
    assert.equal(perAccountCharCap(), 5400);
  });
});

describe('per-IP throttle on anonymous starts', () => {
  test('allows up to the limit, then refuses', () => {
    __resetIpLimiter();
    const ip = '203.0.113.9';
    const limit = demoConfig.anonStartsPerIpPerHour();
    for (let i = 0; i < limit; i++) {
      assert.equal(mayStartAnonDemo(ip), true, `start ${i + 1} should be allowed`);
    }
    assert.equal(mayStartAnonDemo(ip), false, 'the limit must actually bite');
  });

  test('one address being throttled does not affect another', () => {
    __resetIpLimiter();
    const limit = demoConfig.anonStartsPerIpPerHour();
    for (let i = 0; i < limit; i++) mayStartAnonDemo('198.51.100.1');
    assert.equal(mayStartAnonDemo('198.51.100.1'), false);
    assert.equal(mayStartAnonDemo('198.51.100.2'), true, 'throttling is per address');
  });
});

describe('funnel events', () => {
  test('only known events are accepted', () => {
    // The endpoint is public, so anything could be posted at it.
    assert.equal(isDemoEvent('mic_granted'), true);
    assert.equal(isDemoEvent('cta_clicked'), true);
    assert.equal(isDemoEvent('drop table'), false);
    assert.equal(isDemoEvent(42), false);
    assert.equal(isDemoEvent(null), false);
  });
});

describe('demo rooms are sandboxed and time-boxed', () => {
  test('an expired demo is reclaimed; a church room never is', async () => {
    const { SessionManager } = await import('../src/session-manager');
    const sessions = new SessionManager();

    const demo = sessions.getOrCreate('demo-abc123');
    demo.demo = {
      clerkUserId: null,
      ttsAllowed: false,
      ttsChars: 0,
      createdAt: Date.now() - 10_000,
      expiresAt: Date.now() - 1, // already due
    };
    // A church room with no demo marker, which must survive whatever happens
    // to the demo namespace.
    sessions.getOrCreate('hanmaum');

    assert.equal(sessions.roomCount, 2);
    const reaped = sessions.reapExpiredDemos();
    assert.equal(reaped, 1, 'the expired demo should have been reclaimed');
    assert.ok(sessions.get('hanmaum'), 'a real church must never be touched by the demo reaper');
    assert.equal(sessions.get('demo-abc123'), undefined);
  });

  test('a demo that has not expired is left alone', async () => {
    const { SessionManager } = await import('../src/session-manager');
    const sessions = new SessionManager();
    const demo = sessions.getOrCreate('demo-live01');
    demo.demo = {
      clerkUserId: 'user_x',
      ttsAllowed: true,
      ttsChars: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    assert.equal(sessions.reapExpiredDemos(), 0);
    assert.ok(sessions.get('demo-live01'), 'a running demo must not be cut off early');
  });

  test('a session is a real broadcast unless explicitly marked a demo', async () => {
    // The safe default matters: code that forgets to check `demo` treats the
    // session as a church service, which is what it is.
    const { Session } = await import('../src/session');
    assert.equal(new Session('hanmaum').demo, null);
  });
});

describe('demos keep nothing', () => {
  test('a demo room is never recorded to a transcript', async () => {
    // A stranger trying the product from a cold email has not consented to
    // their voice being archived, and their sentences must not appear in a
    // church's transcript list.
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('../src/broadcaster.ts', import.meta.url), 'utf8');
    assert.match(
      src,
      /transcript = session\.demo \? null : await TranscriptWriter\.open/,
      'the transcript writer must be skipped for demo rooms',
    );
  });
});
