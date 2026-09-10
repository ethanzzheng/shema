import { isDuplicateUtterance } from '../src/stt';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksComplete,
  endsWithKoreanFinalEnding,
  endsWithKoreanConnective,
  endsWithStrongTerminator,
  splitSentences,
  endsWithDanglingHead,
  splitLastKoreanClause,
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

test('endsWithDanglingHead: object/topic particles leave a syntactic hole', () => {
  // The live failure: the object and its relative clause were cut away from
  // the head noun, so English attached the modifier to the wrong referent.
  assert.equal(endsWithDanglingHead('자기 피로 사신 그 교회를'), true);
  assert.equal(endsWithDanglingHead('예수 그리스도의 교회, 자기 피로 사신 교회를'), true);
  assert.equal(endsWithDanglingHead('자기 것으로 만들려고 하는'), true);
  assert.equal(endsWithDanglingHead('하나님의'), true);
  // Complete sentences and verbal connectives are not dangling.
  assert.equal(endsWithDanglingHead('기도합니다'), false);
  assert.equal(endsWithDanglingHead('감사합니다.'), false);
  assert.equal(endsWithDanglingHead('기도하고'), false);
  assert.equal(endsWithDanglingHead('사랑하면'), false);
});

test('splitLastKoreanClause: ships a safe head and keeps the dangling tail', () => {
  const s = splitLastKoreanClause(
    '우리는 하나님을 사랑해야 합니다. 예수 그리스도의 교회, 자기 피로 사신 교회를',
  );
  assert.ok(s, 'expected a safe cut at the sentence boundary');
  assert.ok(s!.head.endsWith('합니다.'), `head should end complete, got: ${s!.head}`);
  assert.equal(endsWithDanglingHead(s!.head), false);
  assert.ok(s!.rest.includes('교회를'), 'the dangling tail stays buffered for its head');
});

test('splitLastKoreanClause: no safe cut returns null', () => {
  assert.equal(splitLastKoreanClause('교회를'), null);
  assert.equal(splitLastKoreanClause('자기 피로 사신 그 교회를'), null);
});

test('isDuplicateUtterance: ordinary repeated phrases are NOT duplicates', () => {
  // Regression: a containment check here dropped 76% of a sermon. Korean
  // phrases recur constantly, and once whitespace is stripped almost any short
  // line is a substring of some recent longer one.
  const recent = [
    '우리는 하나님을 사랑해야 합니다',
    '그런데 우리가 하나님처럼 되지 못하는 이유는 무엇입니까',
    '교회는 가는데 은혜가 되지 않고 오히려 마음이 강팍해지는 거예요',
  ];
  assert.equal(isDuplicateUtterance('하나님을', recent), false);
  assert.equal(isDuplicateUtterance('그렇죠', recent), false);
  assert.equal(isDuplicateUtterance('은혜가 되지 않고', recent), false);
  assert.equal(isDuplicateUtterance('사랑해야 합니다', recent), false);
});

test('isDuplicateUtterance: exact repeats and truncated re-sends are duplicates', () => {
  const recent = ['우리는 하나님을 사랑해야 합니다'];
  assert.equal(isDuplicateUtterance('우리는 하나님을 사랑해야 합니다', recent), true);
  assert.equal(isDuplicateUtterance('우리는 하나님을 사랑해야 합니다.', recent), true); // re-punctuated
  // A truncated re-send is deliberately NOT caught here — that is the
  // audio-interval check's job, and guessing from text risks eating speech.
  assert.equal(isDuplicateUtterance('우리는 하나님을 사랑해야', recent), false);
  assert.equal(isDuplicateUtterance('', recent), true);
});
