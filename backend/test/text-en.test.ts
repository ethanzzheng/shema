import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  endsWithStrongTerminatorEn,
  endsWithEnglishConnective,
  endsWithHardConnective,
  looksCompleteEn,
  splitSentencesEn,
} from '../src/text-en';

test('endsWithStrongTerminatorEn: real boundaries', () => {
  assert.equal(endsWithStrongTerminatorEn('God loves you.'), true);
  assert.equal(endsWithStrongTerminatorEn('Do you believe that?'), true);
  assert.equal(endsWithStrongTerminatorEn('Praise the Lord!'), true);
  assert.equal(endsWithStrongTerminatorEn('He said, "It is finished."'), true); // closer-stripped
  assert.equal(endsWithStrongTerminatorEn('and then he'), false);
  assert.equal(endsWithStrongTerminatorEn(''), false);
});

test('endsWithStrongTerminatorEn: abbreviations and initials do not end sentences', () => {
  assert.equal(endsWithStrongTerminatorEn('We talked with Dr.'), false);
  assert.equal(endsWithStrongTerminatorEn('down by St.'), false);
  assert.equal(endsWithStrongTerminatorEn('faith vs.'), false);
  assert.equal(endsWithStrongTerminatorEn('at 9 a.m.'), false);
  assert.equal(endsWithStrongTerminatorEn('named John F.'), false); // initial
  assert.equal(endsWithStrongTerminatorEn('He met Dr. Kim.'), true); // real end after the name
});

test('endsWithEnglishConnective: trailing incompleteness signals', () => {
  assert.equal(endsWithEnglishConnective('he took the loaves and'), true);
  assert.equal(endsWithEnglishConnective('we must wait, but'), true);
  assert.equal(endsWithEnglishConnective('he did it because'), true);
  assert.equal(endsWithEnglishConnective('God gave his Son so that'), true); // "so that" via "that"
  assert.equal(endsWithEnglishConnective('the promise which'), true);
  assert.equal(endsWithEnglishConnective('in the presence of'), true);
  assert.equal(endsWithEnglishConnective('he opened the'), true);
  assert.equal(endsWithEnglishConnective('everything he will'), true);
  assert.equal(endsWithEnglishConnective('trailing comma and,'), true); // comma-stripped
});

test('endsWithEnglishConnective: content-word endings are fine', () => {
  assert.equal(endsWithEnglishConnective('God loves you'), false);
  assert.equal(endsWithEnglishConnective('he walked on the water'), false);
  assert.equal(endsWithEnglishConnective(''), false);
});

test('endsWithHardConnective: conjunctions/determiners/aux yes, prepositions no', () => {
  assert.equal(endsWithHardConnective('he took the loaves and'), true);
  assert.equal(endsWithHardConnective('he opened the'), true);
  assert.equal(endsWithHardConnective('everything he will'), true);
  // Strandable prepositions are connectives (unpunctuated) but never hard.
  assert.equal(endsWithHardConnective('that is what we live for'), false);
  assert.equal(endsWithHardConnective('the church I belong to'), false);
  // Demonstrative 'that' and 'or not' legitimately end sentences.
  assert.equal(endsWithHardConnective('Amen to that'), false);
  assert.equal(endsWithHardConnective('whether you believe it or not'), false);
});

test('looksCompleteEn: terminator required, HARD connective vetoes behind a period', () => {
  assert.equal(looksCompleteEn('God loves you.'), true);
  assert.equal(looksCompleteEn('Where do you run first?'), true);
  assert.equal(looksCompleteEn('God loves you'), false); // no punctuation → not confident
  // Deepgram punctuates pause boundaries: a cut clause arrives as "...and."
  assert.equal(looksCompleteEn('he turned to the Lord and.'), false);
  assert.equal(looksCompleteEn('because of the.'), false);
  assert.equal(looksCompleteEn('We talked with Dr.'), false); // abbreviation period
});

test('looksCompleteEn: stranded prepositions end real sentences (no latency hold)', () => {
  // Punchy rhetorical lines — exactly where snappiness matters most.
  assert.equal(looksCompleteEn('What are you waiting for?'), true);
  assert.equal(looksCompleteEn('Who do you belong to?'), true);
  assert.equal(looksCompleteEn("That's what love is for."), true);
  assert.equal(looksCompleteEn("That's what we live for."), true);
  assert.equal(looksCompleteEn('That is the church I belong to.'), true);
  assert.equal(looksCompleteEn('Amen to that.'), true);
  assert.equal(looksCompleteEn('Whether you believe it or not.'), true);
  // Question/exclamation marks never get the veto at all.
  assert.equal(looksCompleteEn('And you would say and?'), true);
});

test('splitSentencesEn: basic split with remainder', () => {
  assert.deepEqual(splitSentencesEn('God is good. God is faithful. And when we'), {
    sentences: ['God is good.', 'God is faithful.'],
    remainder: 'And when we',
  });
});

test('splitSentencesEn: abbreviations and initials do not split', () => {
  assert.deepEqual(splitSentencesEn('We met Dr. Kim at church. He prayed.'), {
    sentences: ['We met Dr. Kim at church.', 'He prayed.'],
    remainder: '',
  });
  assert.deepEqual(splitSentencesEn('John F. Kennedy said this. It stuck.'), {
    sentences: ['John F. Kennedy said this.', 'It stuck.'],
    remainder: '',
  });
});

test('splitSentencesEn: decimals and verse refs stay intact', () => {
  assert.deepEqual(splitSentencesEn('Look at John 3:16. It says everything.'), {
    sentences: ['Look at John 3:16.', 'It says everything.'],
    remainder: '',
  });
  const r = splitSentencesEn('about 3.16 percent of');
  assert.deepEqual(r, { sentences: [], remainder: 'about 3.16 percent of' });
});

test('splitSentencesEn: punctuated mid-clause pause rides on, not cut', () => {
  // Deepgram writes "...and." at a dramatic pause; the clause continues.
  assert.deepEqual(splitSentencesEn('He took the loaves and. He gave thanks.'), {
    sentences: ['He took the loaves and. He gave thanks.'],
    remainder: '',
  });
});

test('splitSentencesEn: preposition-final sentences split normally', () => {
  assert.deepEqual(splitSentencesEn("That's what we live for. Amen to that."), {
    sentences: ["That's what we live for.", 'Amen to that.'],
    remainder: '',
  });
});
