import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeForSpeech,
  looksLikeMetaCommentary,
  extractJsonObject,
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

test('looksLikeMetaCommentary: normal translations pass through', () => {
  assert.equal(looksLikeMetaCommentary('God so loved the world.'), false);
  assert.equal(looksLikeMetaCommentary('Take my yoke upon you and learn from me.'), false);
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
