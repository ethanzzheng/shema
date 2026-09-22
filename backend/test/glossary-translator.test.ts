/**
 * The two-tier split, which is what keeps live glossary edits from costing
 * latency. Constructing a ClaudeTranslator makes no network call, so these
 * assertions run against the real prompt-building code.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { ClaudeTranslator } from '../src/translation';
import { GlossaryTerm } from '../src/glossary/types';

function term(over: Partial<GlossaryTerm> = {}): GlossaryTerm {
  return {
    id: 'id', churchId: 'hanmaum', sessionId: null, sourceTerm: '목장',
    behavior: 'translate', targets: { en: 'Mokjang' }, notes: null,
    createdAt: new Date(0).toISOString(), createdBy: null, ...over,
  };
}

/** The system prompt is private; these tests are about exactly its bytes. */
const systemPromptOf = (t: ClaudeTranslator): string => (t as unknown as { systemPrompt: string }).systemPrompt;

describe('two-tier glossary', () => {
  test('church terms are baked into the cached system prompt', () => {
    const t = new ClaudeTranslator('k', 'm', 'ko-en', 'hanmaum', { churchTerms: [term()] });
    assert.match(systemPromptOf(t), /CHURCH-SPECIFIC NAMES/);
    assert.match(systemPromptOf(t), /목장 = "Mokjang"/);
  });

  test('live terms NEVER reach the system prompt', () => {
    // The whole point: the cached prefix must not depend on anything an
    // operator can change mid-broadcast.
    const live = [term({ id: 'live', sessionId: 's1', sourceTerm: '은혜의강', targets: { en: 'River of Grace' } })];
    const t = new ClaudeTranslator('k', 'm', 'ko-en', 'hanmaum', {
      churchTerms: [term()],
      getLiveTerms: () => live,
    });
    assert.ok(!systemPromptOf(t).includes('은혜의강'), 'a live term leaked into the cached prompt');
    assert.ok(!systemPromptOf(t).includes('River of Grace'));
  });

  test('the system prompt is byte-identical however the live terms change', () => {
    const churchTerms = [term()];
    const a = new ClaudeTranslator('k', 'm', 'ko-en', 'hanmaum', { churchTerms, getLiveTerms: () => [] });
    const b = new ClaudeTranslator('k', 'm', 'ko-en', 'hanmaum', {
      churchTerms,
      getLiveTerms: () => [term({ id: 'x', sessionId: 's', sourceTerm: '새노래', targets: { en: 'New Song' } })],
    });
    assert.equal(systemPromptOf(a), systemPromptOf(b), 'cache prefix differs — every edit would cost a cache miss');
  });

  test('falls back to the env glossary when no church terms are supplied', () => {
    const prev = process.env.CHURCH_GLOSSARY;
    process.env.CHURCH_GLOSSARY = '목자=shepherd';
    try {
      const t = new ClaudeTranslator('k', 'm', 'ko-en', 'hanmaum');
      assert.match(systemPromptOf(t), /목자 = "shepherd"/);
    } finally {
      if (prev === undefined) delete process.env.CHURCH_GLOSSARY;
      else process.env.CHURCH_GLOSSARY = prev;
    }
  });

  test('an explicitly empty church glossary adds no section', () => {
    const t = new ClaudeTranslator('k', 'm', 'ko-en', 'hanmaum', { churchTerms: [] });
    assert.ok(!systemPromptOf(t).includes('CHURCH-SPECIFIC NAMES'));
  });

  test('en-ko renders the Korean target', () => {
    const t = new ClaudeTranslator('k', 'm', 'en-ko', 'hanmaum', {
      churchTerms: [term({ sourceTerm: 'Mokjang', targets: { ko: '목장', en: 'Mokjang' } })],
    });
    assert.match(systemPromptOf(t), /Mokjang = "목장"/);
  });
});
