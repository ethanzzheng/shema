/**
 * The en-ko eval harness's deterministic checkers. These run without any API
 * key — they are what makes the Korean output auditable by a non-speaker, so
 * they get pinned here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerViolations,
  hasDivineHonorific,
  strayEnglishWords,
  hangulRatio,
  englishBookNamesIn,
  sentenceEndingForms,
  maxConsecutiveEnding,
} from '../evals/run-en-ko';

test('registerViolations: 하십시오체 sentences pass', () => {
  assert.deepEqual(registerViolations('하나님께서 여러분을 사랑하십니다.'), []);
  assert.deepEqual(registerViolations('믿음은 감정이 아닙니다. 믿음은 결단입니다.'), []);
  assert.deepEqual(registerViolations('여러분은 어디로 먼저 달려가십니까?'), []);
  assert.deepEqual(registerViolations('말씀을 함께 읽으시기 바랍니다.'), []);
  assert.deepEqual(registerViolations('일어나 주십시오.'), []);
  assert.deepEqual(registerViolations('함께 기도합시다.'), []);
  assert.deepEqual(registerViolations('주여, 우리를 도우소서.'), []);
});

test('registerViolations: casual 반말 / plain endings are flagged', () => {
  assert.equal(registerViolations('하나님이 너를 사랑해.').length, 1);
  assert.equal(registerViolations('포기하지 마.').length, 1);
  assert.equal(registerViolations('하나님은 변하지 않는다.').length, 1);
  assert.equal(registerViolations('그렇지?').length, 1);
});

test('registerViolations: 해요체 as a sentence default is flagged', () => {
  assert.equal(registerViolations('하나님이 여러분을 사랑해요.').length, 1);
});

test('registerViolations: trailing vocatives ride after the verb', () => {
  // Live false positive: the verb is 안녕하십니까; 성도 여러분 is a vocative.
  assert.deepEqual(registerViolations('안녕하십니까, 성도 여러분.'), []);
  assert.deepEqual(registerViolations('포기하지 마십시오, 사랑하는 여러분.'), []);
  assert.deepEqual(registerViolations('사랑하는 여러분!'), []);
  // The vocative must not launder a casual verb.
  assert.equal(registerViolations('하나님이 너를 사랑해, 여러분.').length, 1);
});

test('registerViolations: interjections and quoted dialogue are exempt', () => {
  assert.deepEqual(registerViolations('아멘? 하나님은 선하십니다.'), []);
  assert.deepEqual(registerViolations('할렐루야!'), []);
  // Quoted casual speech is the quoted speaker's register, not the pastor's.
  assert.deepEqual(registerViolations('아버지는 "얘야, 이리 오너라." 하고 부르셨습니다.'), []);
});

test('registerViolations: unterminated trailing fragment (mid-cut) is skipped', () => {
  assert.deepEqual(registerViolations('사도 바울이 교회에 보낸 편지를 보면'), []);
  assert.deepEqual(registerViolations('그것이 옳습니다. 그런데 우리가'), []);
});

test('hasDivineHonorific: 께서 or honorific -시- forms pass', () => {
  assert.equal(hasDivineHonorific('하나님께서 여러분을 사랑하십니다.'), true);
  assert.equal(hasDivineHonorific('예수님께서 십자가에서 죽으셨습니다.'), true);
  // Correct honorific without 께서 (topic particle + -시-):
  assert.equal(hasDivineHonorific('하나님은 언제나 선하십니다.'), true);
});

test('hasDivineHonorific: plain non-honorific speech fails', () => {
  assert.equal(hasDivineHonorific('하나님이 너를 사랑한다.'), false);
  assert.equal(hasDivineHonorific('예수가 죽었다.'), false);
});

test('strayEnglishWords: flags untranslated English, honors allowlist', () => {
  assert.deepEqual(strayEnglishWords('하나님의 grace는 충분합니다.'), ['grace']);
  assert.deepEqual(strayEnglishWords('QT를 하시기 바랍니다.'), []); // global allowlist
  assert.deepEqual(strayEnglishWords('David의 시편입니다.', ['David']), []);
  assert.deepEqual(strayEnglishWords('하나님께서 일하십니다.'), []);
});

test('hangulRatio: Korean output scores high, half-English scores low', () => {
  assert.ok(hangulRatio('하나님께서 여러분을 사랑하십니다.') === 1);
  assert.ok(hangulRatio('God loves you, 여러분.') < 0.8);
  assert.equal(hangulRatio('123 !?'), 0);
});

test('sentenceEndingForms: classifies formal endings, most specific first', () => {
  // 일하십니다 (honorific) and plain 합니다 share the ear's '니다' cadence.
  assert.deepEqual(
    sentenceEndingForms('하나님께서 일하십니다. 그것이 은혜인 것입니다. 함께 기도하시기 바랍니다. 그렇지 않습니까?'),
    ['니다', '것입니다', '바랍니다', '않습니까'],
  );
});

test('maxConsecutiveEnding: counts the longest identical-ending run', () => {
  assert.equal(maxConsecutiveEnding(['습니다', '습니다', '습니다', '것입니다']), 3);
  assert.equal(maxConsecutiveEnding(['습니다', '것입니다', '습니다']), 1);
  assert.equal(maxConsecutiveEnding([]), 0);
});

test('englishBookNamesIn: catches English book names, word-bounded', () => {
  assert.deepEqual(englishBookNamesIn('John 3:16 말씀입니다.'), ['John']);
  assert.deepEqual(englishBookNamesIn('요한복음 3장 16절 말씀입니다.'), []);
});
