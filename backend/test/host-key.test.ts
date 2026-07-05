/**
 * Phase A host-key auth: env parsing + validation rules.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { requiredHostKey, isHostKeyValid } from '../src/host-key';

describe('requiredHostKey', () => {
  test('no config → room is open', () => {
    assert.equal(requiredHostKey('any-room', {}), null);
  });

  test('shared BROADCAST_HOST_KEY covers all rooms', () => {
    const env = { BROADCAST_HOST_KEY: 'shared-secret' };
    assert.equal(requiredHostKey('a', env), 'shared-secret');
    assert.equal(requiredHostKey('b', env), 'shared-secret');
  });

  test('ROOM_HOST_KEYS maps per room and wins over the shared key', () => {
    const env = {
      ROOM_HOST_KEYS: 'grace-church:abc123, hanmaeum:xyz789',
      BROADCAST_HOST_KEY: 'shared',
    };
    assert.equal(requiredHostKey('grace-church', env), 'abc123');
    assert.equal(requiredHostKey('hanmaeum', env), 'xyz789');
    assert.equal(requiredHostKey('other', env), 'shared'); // falls back
  });

  test('malformed ROOM_HOST_KEYS entries are ignored', () => {
    const env = { ROOM_HOST_KEYS: 'nokey,:noroom,ok:fine' };
    assert.equal(requiredHostKey('ok', env), 'fine');
    assert.equal(requiredHostKey('nokey', env), null);
  });

  test('keys containing colons survive (split on first colon only)', () => {
    const env = { ROOM_HOST_KEYS: 'a:key:with:colons' };
    assert.equal(requiredHostKey('a', env), 'key:with:colons');
  });
});

describe('isHostKeyValid', () => {
  const env = { ROOM_HOST_KEYS: 'grace-church:abc123' };

  test('open room accepts anything, including nothing', () => {
    assert.equal(isHostKeyValid('open-room', undefined, {}), true);
    assert.equal(isHostKeyValid('open-room', 'whatever', {}), true);
  });

  test('locked room: correct key passes (with trim)', () => {
    assert.equal(isHostKeyValid('grace-church', 'abc123', env), true);
    assert.equal(isHostKeyValid('grace-church', '  abc123  ', env), true);
  });

  test('locked room: wrong / missing / non-string keys fail', () => {
    assert.equal(isHostKeyValid('grace-church', 'wrong', env), false);
    assert.equal(isHostKeyValid('grace-church', undefined, env), false);
    assert.equal(isHostKeyValid('grace-church', '', env), false);
    assert.equal(isHostKeyValid('grace-church', 123, env), false);
    assert.equal(isHostKeyValid('grace-church', 'abc12', env), false); // length mismatch
  });
});
