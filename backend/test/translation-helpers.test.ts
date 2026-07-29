import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeForSpeech,
  looksLikeMetaCommentary,
  extractJsonObject,
  SYSTEM_PROMPT_KO_EN,
  SYSTEM_PROMPT_EN_KO,
} from '../src/translation';

test('sanitizeForSpeech: em/en dashes become comma pauses', () => {
  assert.equal(
    sanitizeForSpeech('that design of faith—when your faith is big'),
    'that design of faith, when your faith is big',
  );
  assert.equal(sanitizeForSpeech('Andrew – that is faith'), 'Andrew, that is faith');
});

test('sanitizeForSpeech: trailing dash / ellipsis stripped', () => {
  assert.equal(sanitizeForSpeech('Jesus takes hold of that faith and—'), 'Jesus takes hold of that faith');
  assert.equal(sanitizeForSpeech('He said...'), 'He said');
});

test('sanitizeForSpeech: stranded conjunction at end removed', () => {
  assert.equal(sanitizeForSpeech('he took the loaves and'), 'he took the loaves');
  assert.equal(sanitizeForSpeech('we must wait, but'), 'we must wait');
  // a real sentence ending in a content word is untouched
  assert.equal(sanitizeForSpeech('we must wait.'), 'we must wait.');
});

test('sanitizeForSpeech: strips an abandoned false-start subject at the end', () => {
  // The observed live bug: pastor abandons "그 내가" → model emits "That, I".
  assert.equal(sanitizeForSpeech('Right? That, I'), 'Right?');
  assert.equal(sanitizeForSpeech('So we need to align ourselves, and we'), 'So we need to align ourselves');
  assert.equal(sanitizeForSpeech('I need to stop and wait, I'), 'I need to stop and wait');
  // real sentences ending in a content word or object are untouched
  assert.equal(sanitizeForSpeech('I never knew that'), 'I never knew that');
  assert.equal(sanitizeForSpeech('Love your neighbor as yourself.'), 'Love your neighbor as yourself.');
  assert.equal(sanitizeForSpeech('He will meet that need for you.'), 'He will meet that need for you.');
});

test('sanitizeForSpeech: tidies doubled punctuation and spacing', () => {
  assert.equal(sanitizeForSpeech('faith,  , hope'), 'faith, hope');
  assert.equal(sanitizeForSpeech('grace  and   truth .'), 'grace and truth.');
});

test('looksLikeMetaCommentary: catches model describing the input', () => {
  assert.equal(
    looksLikeMetaCommentary("The segment appears incomplete mid-phrase ('our people's...')"),
    true,
  );
  assert.equal(looksLikeMetaCommentary('This appears incomplete and requires the continuation'), true);
  assert.equal(looksLikeMetaCommentary('I cannot translate this segment'), true);
});

test('looksLikeMetaCommentary: catches translator-voice analysis and refusals', () => {
  assert.equal(looksLikeMetaCommentary('The input text ends mid-sentence'), true);
  assert.equal(looksLikeMetaCommentary('The sentence is cut off before the verb'), true);
  assert.equal(looksLikeMetaCommentary('As an interpreter, I would render this as...'), true);
  assert.equal(looksLikeMetaCommentary("I'm unable to translate this fragment"), true);
  assert.equal(looksLikeMetaCommentary('I am unable to provide a translation'), true);
});

test('looksLikeMetaCommentary: normal translations pass through', () => {
  assert.equal(looksLikeMetaCommentary('God so loved the world.'), false);
  assert.equal(looksLikeMetaCommentary('Take my yoke upon you and learn from me.'), false);
});

test('looksLikeMetaCommentary: sermon word-studies and quoted speech are NOT meta', () => {
  // The exact class of line the old guard wrongly dropped (soak seq 115):
  assert.equal(
    looksLikeMetaCommentary(
      'Here, this word in the passage, if you look at it in the original Greek, means soldiers marching in step.',
    ),
    false,
  );
  assert.equal(looksLikeMetaCommentary('If you look at the text, Jesus says to love your neighbor.'), false);
  assert.equal(looksLikeMetaCommentary('This sentence is the heart of the whole chapter.'), false);
  assert.equal(looksLikeMetaCommentary("I still can't forget what he said to me."), false);
  assert.equal(looksLikeMetaCommentary("I can't do this alone, right?"), false);
  assert.equal(looksLikeMetaCommentary('The passage we will share together today is John chapter three.'), false);
});

test('looksLikeMetaCommentary: Korean translator-voice tells (en-ko output)', () => {
  assert.equal(looksLikeMetaCommentary('이 문장은 불완전합니다'), true);
  assert.equal(looksLikeMetaCommentary('이 세그먼트는 잘려 있어 번역할 수 없습니다'), true);
  assert.equal(looksLikeMetaCommentary('번역이 불가능합니다'), true);
  assert.equal(looksLikeMetaCommentary('통역사로서 이 부분은 생략하겠습니다'), true);
});

test('looksLikeMetaCommentary: normal Korean sermon lines pass through', () => {
  assert.equal(looksLikeMetaCommentary('하나님께서 여러분을 사랑하십니다.'), false);
  assert.equal(looksLikeMetaCommentary('요한복음 3장 16절 말씀을 함께 읽겠습니다.'), false);
  // A pastor SAYING a sentence is incomplete about life, not the input, is fine.
  assert.equal(looksLikeMetaCommentary('우리의 믿음은 아직 완전하지 않습니다.'), false);
});

test('system prompts: ko-en is the original; en-ko carries register/honorific/개역개정 rules', () => {
  // ko-en spot-checks (pinned so the en-ko work can't drift it).
  assert.ok(SYSTEM_PROMPT_KO_EN.startsWith('You are a professional simultaneous interpreter translating a LIVE Korean church sermon into English'));
  assert.ok(SYSTEM_PROMPT_KO_EN.includes('Mokjang'));
  assert.ok(SYSTEM_PROMPT_KO_EN.includes('NIV-style'));
  // en-ko linguistic core.
  assert.ok(SYSTEM_PROMPT_EN_KO.includes('하십시오체'));
  assert.ok(SYSTEM_PROMPT_EN_KO.includes('반말'));
  assert.ok(SYSTEM_PROMPT_EN_KO.includes('하나님께서'));
  assert.ok(SYSTEM_PROMPT_EN_KO.includes('예수님께서'));
  assert.ok(SYSTEM_PROMPT_EN_KO.includes('개역개정'));
  assert.ok(SYSTEM_PROMPT_EN_KO.includes('요한복음 3장 16절'));
  assert.ok(SYSTEM_PROMPT_EN_KO.includes('{"translation"')); // same JSON contract
});

test('extractJsonObject: plain JSON passes through', () => {
  assert.equal(extractJsonObject('{"translation": "hi"}'), '{"translation": "hi"}');
});

test('extractJsonObject: strips code fences', () => {
  assert.equal(extractJsonObject('```json\n{"translation": "hi"}\n```'), '{"translation": "hi"}');
  assert.equal(extractJsonObject('```\n{"translation": "hi"}\n```'), '{"translation": "hi"}');
});

test('extractJsonObject: extracts object from surrounding prose', () => {
  assert.equal(
    extractJsonObject('Here is the result: {"translation": "hi"} hope that helps'),
    '{"translation": "hi"}',
  );
});
