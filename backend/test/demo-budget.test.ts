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
