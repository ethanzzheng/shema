/**
 * Glossary rendering, chunk filtering, keyterm budgeting, and the env fallback.
 * Pure functions only — nothing here touches a database.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  budgetKeyterms,
  estimateTokens,
  liveTermsForChunk,
  renderGlossaryLines,
  termsInText,
  MAX_KEYTERMS,
} from '../src/glossary/merge';
import { envGlossaryPairs, envTerms, glossaryEnvKey, parseGlossaryPairs } from '../src/glossary/env';
import { GlossaryTerm } from '../src/glossary/types';

function term(over: Partial<GlossaryTerm> = {}): GlossaryTerm {
  return {
    id: 'id',
    churchId: 'hanmaum',
    sessionId: null,
    sourceTerm: '목장',
    behavior: 'translate',
    targets: { en: 'Mokjang' },
    notes: null,
    createdAt: new Date(0).toISOString(),
    createdBy: null,
    ...over,
  };
}

describe('renderGlossaryLines', () => {
  test('renders a forced translation in the existing prompt format', () => {
    assert.equal(renderGlossaryLines([term()], 'en'), '목장 = "Mokjang"');
  });

  test('a "keep" term tells the model not to translate it', () => {
    const line = renderGlossaryLines([term({ sourceTerm: '한마음', behavior: 'keep', targets: {} })], 'en');
    assert.match(line, /^한마음 = keep as "한마음"/);
    assert.match(line, /do not translate/);
  });

  test('a service term overrides a church term with the same source', () => {
    const out = renderGlossaryLines(
      [
        term({ id: 'church', targets: { en: 'Mokjang' } }),
        term({ id: 'service', sessionId: 's1', targets: { en: 'Small Group' } }),
      ],
      'en',
    );
    assert.equal(out, '목장 = "Small Group"');
  });

  test('falls back to any target when the output language has none', () => {
    // The seeded env glossary only ever carried English; a Korean-output
    // broadcast should still pin the name rather than drop it.
    assert.equal(renderGlossaryLines([term()], 'ko'), '목장 = "Mokjang"');
  });

  test('skips a translate term with no targets at all', () => {
    assert.equal(renderGlossaryLines([term({ targets: {} })], 'en'), '');
  });
});

describe('termsInText / liveTermsForChunk', () => {
  test('matches Korean by substring, since there are no word boundaries', () => {
    const found = termsInText([term(), term({ sourceTerm: '빌립' })], '오늘 목장 모임이 있습니다');
    assert.deepEqual(found.map((t) => t.sourceTerm), ['목장']);
  });

  test('matches Latin script case-insensitively', () => {
    const found = termsInText([term({ sourceTerm: 'Mokjang', targets: { ko: '목장' } })], 'the mokjang met');
    assert.equal(found.length, 1);
  });

  test('sends the whole list while it is small', () => {
    const terms = [term(), term({ sourceTerm: '빌립' })];
    assert.equal(liveTermsForChunk(terms, 'unrelated text').length, 2);
  });

  test('filters to what the chunk mentions once the list is large', () => {
    const many = Array.from({ length: 150 }, (_, i) => term({ id: `t${i}`, sourceTerm: `단어${i}` }));
    const picked = liveTermsForChunk(many, '오늘 단어7 이야기');
    assert.deepEqual(picked.map((t) => t.sourceTerm), ['단어7']);
  });
});

describe('budgetKeyterms', () => {
  test('glossary terms come before the generic defaults', () => {
    const { keyterms } = budgetKeyterms(['목장'], ['예수']);
    assert.deepEqual(keyterms, ['목장', '예수']);
  });

  test('de-duplicates across both lists', () => {
    const { keyterms } = budgetKeyterms(['목장'], ['목장', '예수']);
    assert.deepEqual(keyterms, ['목장', '예수']);
  });

  test('caps at the provider term limit and reports what was dropped', () => {
    const glossary = Array.from({ length: 140 }, (_, i) => `단어${i}`);
    const { keyterms, dropped } = budgetKeyterms(glossary, []);
    assert.equal(keyterms.length, MAX_KEYTERMS);
    assert.ok(dropped.length > 0, 'truncation must be reported, never silent');
    assert.equal(keyterms.length + dropped.length, 140);
  });

  test('caps on estimated tokens as well as count', () => {
    const long = Array.from({ length: 40 }, (_, i) => `아주아주아주긴단어입니다${i}`);
    const { keyterms } = budgetKeyterms(long, []);
    const tokens = keyterms.reduce((n, k) => n + estimateTokens(k), 0);
    assert.ok(tokens <= 500, `token budget exceeded: ${tokens}`);
  });

  test('ignores blanks', () => {
    assert.deepEqual(budgetKeyterms(['', '  '], ['예수']).keyterms, ['예수']);
  });
});

describe('env fallback', () => {
  test('splits on the first = so a rendering may contain one', () => {
    const m = new Map<string, string>();
    parseGlossaryPairs('a=b=c,목장=Mokjang', m);
    assert.equal(m.get('a'), 'b=c');
    assert.equal(m.get('목장'), 'Mokjang');
  });

  test('ignores malformed pairs', () => {
    const m = new Map<string, string>();
    parseGlossaryPairs('broken,=,x=,한마음=Hanmaum', m);
    assert.deepEqual([...m], [['한마음', 'Hanmaum']]);
  });

  test('the per-church var overrides the global one', () => {
    const env = {
      CHURCH_GLOSSARY: '목자=shepherd',
      CHURCH_GLOSSARY_HANMAUM: '목자=Mokja',
    } as NodeJS.ProcessEnv;
    assert.equal(envGlossaryPairs(env, 'hanmaum').get('목자'), 'Mokja');
    assert.equal(envGlossaryPairs(env, 'other').get('목자'), 'shepherd');
  });

  test('env pairs become church-scope terms the pipeline can use directly', () => {
    const env = { CHURCH_GLOSSARY: '목장=Mokjang' } as NodeJS.ProcessEnv;
    const [t] = envTerms('hanmaum', env, 'en');
    assert.equal(t.sourceTerm, '목장');
    assert.equal(t.sessionId, null, 'env terms are church scope');
    assert.equal(t.behavior, 'translate');
    assert.deepEqual(t.targets, { en: 'Mokjang' });
    assert.equal(renderGlossaryLines(envTerms('hanmaum', env, 'en'), 'en'), '목장 = "Mokjang"');
  });

  test('slug to env var name', () => {
    assert.equal(glossaryEnvKey('grace-church'), 'CHURCH_GLOSSARY_GRACE_CHURCH');
  });
});
