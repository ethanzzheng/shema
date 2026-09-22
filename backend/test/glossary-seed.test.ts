/**
 * Church discovery for the env -> database seed. No database involved.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { churchesFromEnv } from '../scripts/seed-glossary';

describe('churchesFromEnv', () => {
  test('recovers the slug from the env var name', () => {
    const env = {
      CHURCH_GLOSSARY: '목장=Mokjang',
      CHURCH_GLOSSARY_HANMAUM: '한마음=Hanmaum',
      CHURCH_GLOSSARY_GRACE_CHURCH: '은혜교회=Grace Church',
    } as NodeJS.ProcessEnv;
    assert.deepEqual(churchesFromEnv(env).sort(), ['grace-church', 'hanmaum']);
  });

  test('the global var alone names no church', () => {
    // It applies to every church, so there is nothing to attribute it to
    // without being told which church to seed.
    assert.deepEqual(churchesFromEnv({ CHURCH_GLOSSARY: '목장=Mokjang' } as NodeJS.ProcessEnv), []);
  });

  test('ignores empty vars', () => {
    const env = { CHURCH_GLOSSARY_EMPTY: '   ', CHURCH_GLOSSARY_REAL: 'a=b' } as NodeJS.ProcessEnv;
    assert.deepEqual(churchesFromEnv(env), ['real']);
  });
});
