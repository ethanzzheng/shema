import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksComplete,
  endsWithKoreanFinalEnding,
  endsWithKoreanConnective,
  endsWithStrongTerminator,
  splitSentences,
} from '../src/text';

test('endsWithStrongTerminator: punctuation only', () => {
  assert.equal(endsWithStrongTerminator('알아야 된다는 것입니다.'), true);
  assert.equal(endsWithStrongTerminator('없습니까?'), true);
  assert.equal(endsWithStrongTerminator('했다!'), true);
  assert.equal(endsWithStrongTerminator('그랬다."'), true); // trailing quote after punct
  assert.equal(endsWithStrongTerminator('기도합니다'), false); // final ending but no punct
  assert.equal(endsWithStrongTerminator(''), false);
});

test('endsWithKoreanFinalEnding: formal/polite sentence enders', () => {
  assert.equal(endsWithKoreanFinalEnding('기도합니다'), true);
  assert.equal(endsWithKoreanFinalEnding('겸손하신 분입니다'), true);
  assert.equal(endsWithKoreanFinalEnding('더 귀하지요'), true);
  assert.equal(endsWithKoreanFinalEnding('찾는 거예요'), true);
  assert.equal(endsWithKoreanFinalEnding('그렇죠'), true);
  assert.equal(endsWithKoreanFinalEnding('기도하고'), false);
  assert.equal(endsWithKoreanFinalEnding('믿었으면'), false);
});

test('endsWithKoreanConnective: incomplete clause endings', () => {
  // connectives — more is coming
  assert.equal(endsWithKoreanConnective('기도하고'), true);
  assert.equal(endsWithKoreanConnective('믿었으면'), true);
  assert.equal(endsWithKoreanConnective('올 줄은'), true);
  assert.equal(endsWithKoreanConnective('잊어버릴 수도'), true);
  assert.equal(endsWithKoreanConnective('예수님이'), true); // subject particle
  assert.equal(endsWithKoreanConnective('주님은'), true);
  // final endings are NOT connectives (final wins)
  assert.equal(endsWithKoreanConnective('기도합니다'), false);
  assert.equal(endsWithKoreanConnective('거예요'), false);
});

test('looksComplete: punctuation or final ending', () => {
  assert.equal(looksComplete('알아야 된다는 것입니다.'), true);
  assert.equal(looksComplete('기도합니다'), true);
  assert.equal(looksComplete('그렇죠'), true);
  assert.equal(looksComplete('기도하고'), false);
  assert.equal(looksComplete('우리'), false); // bare noun, ambiguous
});

test('splitSentences: splits on terminal punctuation before whitespace/EOT', () => {
  const r = splitSentences('첫 문장입니다. 둘째 문장입니다. 미완성');
  assert.deepEqual(r.sentences, ['첫 문장입니다.', '둘째 문장입니다.']);
  assert.equal(r.remainder, '미완성');
});

test('splitSentences: decimals and verse refs stay intact', () => {
  const r1 = splitSentences('값은 3.16 입니다 정확히');
  assert.deepEqual(r1.sentences, []);
  assert.equal(r1.remainder, '값은 3.16 입니다 정확히');

  const r2 = splitSentences('John 3:16 says God so loved the world. That is the gospel');
  assert.deepEqual(r2.sentences, ['John 3:16 says God so loved the world.']);
  assert.equal(r2.remainder, 'That is the gospel');
});

test('splitSentences: empty input', () => {
  const r = splitSentences('');
  assert.deepEqual(r.sentences, []);
  assert.equal(r.remainder, '');
});
