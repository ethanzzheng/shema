/**
 * Phase A staff auth: login validation, token lifecycle, broadcast gating.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { login, verifyToken, authEnabled, isStartAuthorized } from '../src/auth';

const HASH = bcrypt.hashSync('correct-horse', 10);
const ENV = {
  AUTH_USERS: JSON.stringify({ hanmaum: HASH }),
  AUTH_SECRET: 'test-secret',
};

describe('authEnabled', () => {
  test('off with no config, on with users + secret', () => {
    assert.equal(authEnabled({}), false);
    assert.equal(authEnabled({ AUTH_SECRET: 's' }), false);
    assert.equal(authEnabled({ AUTH_USERS: ENV.AUTH_USERS }), false);
    assert.equal(authEnabled(ENV), true);
  });

  test('malformed AUTH_USERS JSON → auth off (fails closed for logins)', () => {
    const env = { AUTH_USERS: 'not-json', AUTH_SECRET: 's' };
    assert.equal(authEnabled(env), false);
    assert.equal(login('hanmaum', 'correct-horse', env), null);
  });
});

describe('login', () => {
  test('valid credentials → verifiable token containing the username', () => {
    const token = login('hanmaum', 'correct-horse', ENV);
    assert.ok(token);
    assert.equal(verifyToken(token, ENV), 'hanmaum');
  });

  test('username is trimmed', () => {
    assert.ok(login('  hanmaum  ', 'correct-horse', ENV));
  });

  test('wrong password → null', () => {
    assert.equal(login('hanmaum', 'wrong', ENV), null);
  });

  test('unknown user → null', () => {
    assert.equal(login('nobody', 'correct-horse', ENV), null);
  });

  test('non-string inputs → null', () => {
    assert.equal(login(undefined, 'x', ENV), null);
    assert.equal(login('hanmaum', 123 as unknown, ENV), null);
  });
});

describe('verifyToken', () => {
  test('garbage / empty / wrong-secret tokens → null', () => {
    assert.equal(verifyToken('garbage', ENV), null);
    assert.equal(verifyToken('', ENV), null);
    const foreign = jwt.sign({ sub: 'hanmaum' }, 'other-secret');
    assert.equal(verifyToken(foreign, ENV), null);
  });

  test('expired token → null', () => {
    const expired = jwt.sign({ sub: 'hanmaum' }, ENV.AUTH_SECRET, { expiresIn: -1 });
    assert.equal(verifyToken(expired, ENV), null);
  });
});

describe('isStartAuthorized (broadcast gate)', () => {
  test('open mode (no auth config) allows anything', () => {
    assert.deepEqual(isStartAuthorized(undefined, {}), { ok: true, username: null });
    assert.deepEqual(isStartAuthorized('junk', {}), { ok: true, username: null });
  });

  test('auth configured: missing/invalid/expired token rejected', () => {
    assert.equal(isStartAuthorized(undefined, ENV).ok, false);
    assert.equal(isStartAuthorized('junk', ENV).ok, false);
    const expired = jwt.sign({ sub: 'hanmaum' }, ENV.AUTH_SECRET, { expiresIn: -1 });
    assert.equal(isStartAuthorized(expired, ENV).ok, false);
  });

  test('auth configured: fresh login token allowed', () => {
    const token = login('hanmaum', 'correct-horse', ENV);
    const result = isStartAuthorized(token, ENV);
    assert.deepEqual(result, { ok: true, username: 'hanmaum' });
  });
});
