import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { detectReferenceZh, parseChineseNumber } from '../src/scripture-zh';
import {
  splitSentencesZh,
  looksCompleteZh,
  endsDanglingZh,
  endsWithIncompleteReferenceZh,
  splitLastClauseZh,
} from '../src/text-zh';
import { KoreanChunker } from '../src/chunker';
import { getDirectionConfig, normalizeDirection, resolveStt } from '../src/direction-config';
import { SYSTEM_PROMPT_ZH_EN, SYSTEM_PROMPT_KO_EN, SYSTEM_PROMPT_EN_KO } from '../src/translation';

// ── Direction config ──────────────────────────────────────────────────────

test('zh-en: Mandarin in, English out, and never Cantonese', () => {
  const cfg = getDirectionConfig('zh-en');
  assert.equal(cfg.sourceLang, 'zh');
  assert.equal(cfg.targetLang, 'en');
  assert.equal(normalizeDirection('zh-en'), 'zh-en');
  const stt = resolveStt('zh-en', {});
  assert.equal(stt.model, 'nova-3');
  // zh-HK is Cantonese; Mandarin must default to a Mandarin code.
  assert.ok(['zh', 'zh-CN', 'zh-Hans'].includes(stt.language), stt.language);
  // smart_format mangles Chinese numerals ("罗马书8章二十8节").
  assert.equal(stt.smartFormat, false);
  // A Taiwanese congregation can switch to Traditional without a code change.
  assert.equal(resolveStt('zh-en', { STT_LANGUAGE_ZH: 'zh-TW' }).language, 'zh-TW');
});

test('adding zh-en left the existing directions alone', () => {
  assert.equal(resolveStt('ko-en', {}).language, 'ko');
  assert.equal(resolveStt('ko-en', {}).smartFormat, true);
  assert.equal(normalizeDirection('anything-else'), 'ko-en');
  assert.equal(getDirectionConfig('en-ko').targetLang, 'ko');
});

// ── Scripture ─────────────────────────────────────────────────────────────

test('detectReferenceZh: spoken and digit forms', () => {
  assert.deepEqual(detectReferenceZh('我们一起来读约翰福音第三章第十六节'), { book: 'John', chapter: 3, verse: 16 });
  assert.deepEqual(detectReferenceZh('约翰福音3章16节'), { book: 'John', chapter: 3, verse: 16 });
  assert.deepEqual(detectReferenceZh('罗马书第五章第八节说'), { book: 'Romans', chapter: 5, verse: 8 });
  assert.deepEqual(detectReferenceZh('以赛亚五十三章五节'), { book: 'Isaiah', chapter: 53, verse: 5 });
});

test('detectReferenceZh: Psalms are counted in 篇, not 章', () => {
  assert.deepEqual(detectReferenceZh('诗篇二十三篇'), { book: 'Psalms', chapter: 23 });
});

test('detectReferenceZh: mixed numerals from the recogniser', () => {
  // Observed with smart_format on: digits and numerals interleaved.
  assert.deepEqual(detectReferenceZh('罗马书8章二十8节'), { book: 'Romans', chapter: 8, verse: 28 });
});

test('detectReferenceZh: a range anchors on its first verse', () => {
  assert.deepEqual(detectReferenceZh('约翰福音三章十六到十八节'), { book: 'John', chapter: 3, verse: 16 });
});

test('detectReferenceZh: Traditional input', () => {
  assert.deepEqual(detectReferenceZh('創世記一章一節'), { book: 'Genesis', chapter: 1, verse: 1 });
});

test('detectReferenceZh: ordinary words are not references', () => {
  // The Mandarin twins of the 구절 trap.
  assert.equal(detectReferenceZh('我们再看一节经文'), null); // "one more verse", not verse 1
  assert.equal(detectReferenceZh('这节经文'), null);
  assert.equal(detectReferenceZh('今天是我们的节日'), null); // festival
  assert.equal(detectReferenceZh('罗马帝国很强大'), null); // Rome, not Romans
  assert.equal(detectReferenceZh('他来了二十八年'), null);
});

test('detectReferenceZh: short book names need a chapter to count', () => {
  assert.deepEqual(detectReferenceZh('马太五章三节'), { book: 'Matthew', chapter: 5, verse: 3 });
  assert.equal(detectReferenceZh('马太是一个税吏'), null); // Matthew the person
});

test('parseChineseNumber', () => {
  assert.equal(parseChineseNumber('十六'), 16);
  assert.equal(parseChineseNumber('二十八'), 28);
  assert.equal(parseChineseNumber('一百一十九'), 119);
  assert.equal(parseChineseNumber('两'), 2);
  assert.equal(parseChineseNumber('一二'), null); // two words, not a number
});

// ── Sentence grammar ──────────────────────────────────────────────────────

test('splitSentencesZh: splits with no whitespace after the terminator', () => {
  // The Korean splitter requires a space after 。 and returned ZERO sentences
  // for this — which would have held every Mandarin buffer until timeout.
  const r = splitSentencesZh('弟兄姊妹们，平安。今天我们一起来读约翰福音。神爱世人');
  assert.deepEqual(r.sentences, ['弟兄姊妹们，平安。', '今天我们一起来读约翰福音。']);
  assert.equal(r.remainder, '神爱世人');
});

test('splitSentencesZh: half-width punctuation from the recogniser', () => {
  const r = splitSentencesZh('你们知道吗?我们来祷告');
  assert.deepEqual(r.sentences, ['你们知道吗?']);
});

test('looksCompleteZh / endsDanglingZh', () => {
  assert.equal(looksCompleteZh('神爱世人。'), true);
  assert.equal(looksCompleteZh('你们知道吗'), true); // sentence-final particle
  assert.equal(looksCompleteZh('阿们'), true);
  // Modifier before its head noun — the meaning-inversion case.
  assert.equal(endsDanglingZh('这是一种在我们还作罪人的时候就已经临到我们身上的'), true);
  assert.equal(endsDanglingZh('因为'), true);
  assert.equal(endsDanglingZh('我们要把'), true);
  assert.equal(endsDanglingZh('弟兄姊妹，'), true);
  assert.equal(endsDanglingZh('神爱世人。'), false);
});

test('endsWithIncompleteReferenceZh: hold a citation until its verse arrives', () => {
  // Deepgram was observed splitting "约翰福音第" and "3章16节" into SEPARATE finals.
  assert.equal(endsWithIncompleteReferenceZh('我们一起来读约翰福音第'), true);
  assert.equal(endsWithIncompleteReferenceZh('约翰福音第三章'), true);
  assert.equal(endsWithIncompleteReferenceZh('约翰福音第三章第十六节'), false);
});

test('splitLastClauseZh: ships a safe head, keeps the dangling tail', () => {
  const s = splitLastClauseZh('我们常常听到这节经文，这是一种临到我们身上的');
  assert.ok(s);
  assert.equal(s!.head, '我们常常听到这节经文，');
  assert.equal(s!.rest, '这是一种临到我们身上的');
});

// ── Chunker behaviour ─────────────────────────────────────────────────────

const flush = () => new Promise((r) => setImmediate(r));

function makeZh(mode: 'fast' | 'smooth' = 'smooth') {
  const dispatched: string[] = [];
  let seq = 0;
  const chunker = new KoreanChunker({
    mode,
    direction: 'zh-en',
    nextSeq: () => ++seq,
    onChunk: async (text) => {
      dispatched.push(text);
    },
  });
  return { chunker, dispatched };
}

test('zh chunker: complete sentences dispatch immediately and join without spaces', async () => {
  const { chunker, dispatched } = makeZh();
  await chunker.feed('弟兄姊妹们，平安。', true);
  await chunker.feed('今天我们一起来读经。', true);
  await flush();
  assert.ok(dispatched.length >= 1);
  assert.ok(!dispatched.join('').includes(' '), `Chinese must not gain spaces: ${JSON.stringify(dispatched)}`);
});

test('zh chunker VALIDATION: a scripture reference split across finals ships whole', async () => {
  // Exactly what Deepgram did: "…约翰福音第" then "3章16节" as separate finals.
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { chunker, dispatched } = makeZh();
  try {
    await chunker.feed('今天我们一起来读约翰福音第', true);
    mock.timers.tick(6000); // past the ordinary incomplete timeout
    await flush();
    assert.equal(dispatched.length, 0, `shipped a citation with no chapter or verse: ${JSON.stringify(dispatched)}`);
    await chunker.feed('3章16节。', true);
    mock.timers.tick(1000);
    await flush();
    assert.ok(dispatched.some((d) => d.includes('约翰福音第3章16节')), JSON.stringify(dispatched));
  } finally {
    mock.timers.reset();
  }
});

test('zh chunker VALIDATION: a 的-modifier is not shipped without its head noun', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { chunker, dispatched } = makeZh();
  try {
    await chunker.feed('这是一种在我们还作罪人的时候就已经临到我们身上的', true);
    mock.timers.tick(6000);
    await flush();
    assert.equal(dispatched.length, 0, 'shipped a modifier with nothing to modify');
    await chunker.feed('爱。', true);
    mock.timers.tick(1000);
    await flush();
    assert.ok(dispatched.some((d) => d.endsWith('身上的爱。')), JSON.stringify(dispatched));
  } finally {
    mock.timers.reset();
  }
});

test('zh chunker CONTROL: a complete sentence is not delayed', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { chunker, dispatched } = makeZh();
  try {
    await chunker.feed('我们要彼此相爱', true); // no punctuation, no dangling token
    mock.timers.tick(5200);
    await flush();
    assert.equal(dispatched.length, 1, 'an undangling buffer must ship at the normal timeout');
  } finally {
    mock.timers.reset();
  }
});

// ── Prompt ────────────────────────────────────────────────────────────────

test('zh-en prompt carries the Mandarin-specific rules', () => {
  for (const rule of ['弟兄姊妹', '交通', '信息', '慕道友', 'PRONOUNS ARE A GUESS', '一节经文', 'NEVER output Chinese characters', '篇']) {
    assert.ok(SYSTEM_PROMPT_ZH_EN.includes(rule), `missing: ${rule}`);
  }
});

test('no prompt asks for JSON while the parser expects plain text', () => {
  for (const p of [SYSTEM_PROMPT_ZH_EN, SYSTEM_PROMPT_KO_EN, SYSTEM_PROMPT_EN_KO]) {
    assert.ok(!p.includes('must be the JSON object'), 'a stale JSON instruction contradicts the plain-text contract');
  }
});

test('REGRESSION: a tail left after splitting off sentences gets its own patience', async () => {
  // Live in the Mandarin run: a comma-chained announcement was held for most
  // of maxHoldMs, then "…欢迎大家来参加。另外," arrived. The sentence
  // dispatched, and the leftover "另外," inherited the ORIGINAL buffer's start
  // time — its budget was already spent, so "Also" was spoken on its own.
  // The same code path serves Korean.
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { chunker, dispatched } = makeZh();
  try {
    await chunker.feed('弟兄姊妹们，平安，欢迎大家今天来到我们的主日崇拜，', true);
    mock.timers.tick(6000);
    await chunker.feed('在讲道之前有几个报告，下个礼拜六晚上七点有查经聚会，', true);
    mock.timers.tick(7300); // ~13.3s held — the log showed the tail then shipping 773ms later
    await flush();
    assert.equal(dispatched.length, 0, 'comma-chained speech should still be held');
    await chunker.feed('欢迎大家来参加。另外，', true);
    mock.timers.tick(1500);
    await flush();
    assert.ok(dispatched.some((d) => d.endsWith('欢迎大家来参加。')), JSON.stringify(dispatched));
    assert.ok(!dispatched.some((d) => d.trim() === '另外，'), `the dangling tail shipped alone: ${JSON.stringify(dispatched)}`);
    await chunker.feed('师母这个礼拜在医院里。', true);
    mock.timers.tick(1000);
    await flush();
    assert.ok(dispatched.some((d) => d.startsWith('另外，师母')), JSON.stringify(dispatched));
  } finally {
    mock.timers.reset();
  }
});

test('splitLastClauseZh: finds a cut in an unpunctuated run-on', () => {
  // Real recogniser output from a test voice that got almost no punctuation.
  // It reached the hold cap ending on the coverb 在 with no comma to cut at,
  // shipped whole, and the translator finished the sentence on its own.
  const s = splitLastClauseZh(
    '我们常常听到这节经文听到几乎都可以背出来了可是我想问大家一个问题这份爱是一种什么样子爱这不是一种因为我们做着好才做着爱这是一种在',
  );
  assert.ok(s, 'there must be a safe cut');
  assert.ok(!s!.head.endsWith('在'), s!.head);
  assert.ok(s!.rest.endsWith('这是一种在'), 'the dangling tail stays buffered');
});

// ── Cuts observed in the first real service (cbcgl-1011) ──────────────────

test('VALIDATION (real service): 呢 as a topic marker is not a sentence end', () => {
  // Each of these shipped alone and was translated as a whole sentence.
  assert.equal(looksCompleteZh('是很不容易的那今天的经文当中呢'), false); // #57
  assert.equal(looksCompleteZh('罗马书我记得在讲到罗马书第14章的时候呢'), false); // #42
  assert.equal(looksCompleteZh('那主耶稣对彼得的这个挽回呢'), false); // #187
  assert.equal(looksCompleteZh('爱主呢'), false); // #99 → invented "Do they really love the Lord?"
  assert.equal(endsDanglingZh('爱主呢'), true);
  // CONTROL: a real question still ends on 呢.
  assert.equal(looksCompleteZh('那最后约翰福音以什么为结尾呢'), true);
  assert.equal(looksCompleteZh('他跟彼得的区别是什么呢'), true);
  assert.equal(looksCompleteZh('我们还是他呢'), true);
});

test('VALIDATION (real service): subordinate clauses, adverbs and modals hold', () => {
  assert.equal(endsDanglingZh('这里边的特别讲到了是和彼得在一起的时候'), true); // #39
  assert.equal(endsDanglingZh('我们要追求和睦彼此建立德行的事这样才'), true); // #43 → "so that we."
  assert.equal(endsDanglingZh('仍然是紧紧的抓住主就像'), true); // #251 → "just like."
  assert.equal(endsDanglingZh('如果你愿意的话'), true);
  assert.equal(endsDanglingZh('我们都'), true);
  assert.equal(endsDanglingZh('我们应该'), true);
  assert.equal(endsDanglingZh('我们会'), true);
  assert.equal(endsDanglingZh('感谢你舍己的爱主啊'), true); // vocative: the petition follows
  // CONTROL: ordinary words that merely END in those characters.
  assert.equal(endsDanglingZh('欢迎大家来到教会'), false);
  assert.equal(endsDanglingZh('这一点非常重要'), false);
  assert.equal(endsDanglingZh('我们不要拜偶像'), false);
  assert.equal(endsDanglingZh('我们下午有聚会'), false);
});

test('splitLastClauseZh: cuts after a tag question, not after a topic 呢', () => {
  const s = splitLastClauseZh('他们都是渔夫是吧那后来呢他们回到了加利利');
  assert.ok(s);
  assert.equal(s!.head, '他们都是渔夫是吧');
  const t = splitLastClauseZh('那今天的经文当中呢主耶稣就不停的问彼得');
  assert.ok(!t || !t.head.endsWith('呢'), JSON.stringify(t));
});

test('zh chunker VALIDATION (real service): an expired unpunctuated buffer cuts before a new sentence', async () => {
  // Real speech: almost no punctuation, so the buffer end is wherever a pause
  // fell. At patience expiry the chunker should cut at the last sentence
  // opener and keep the new sentence's start buffered.
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { chunker, dispatched } = makeZh();
  try {
    await chunker.feed('门徒在跟随主的路上常常争论谁为大所以彼得也在和约翰比较', true);
    mock.timers.tick(5200);
    await flush();
    assert.equal(dispatched[0], '门徒在跟随主的路上常常争论谁为大', JSON.stringify(dispatched));
  } finally {
    mock.timers.reset();
  }
});

test('glossary env fallback only reaches rooms that speak the term language', async () => {
  const { matchesSourceLanguage } = await import('../src/glossary/load');
  const term = (sourceTerm: string) => ({ sourceTerm } as Parameters<typeof matchesSourceLanguage>[0]);
  assert.equal(matchesSourceLanguage(term('목장'), 'zh'), false);
  assert.equal(matchesSourceLanguage(term('목장'), 'ko'), true);
  assert.equal(matchesSourceLanguage(term('团契'), 'zh'), true);
  assert.equal(matchesSourceLanguage(term('团契'), 'ko'), false);
  assert.equal(matchesSourceLanguage(term('QT'), 'ko'), true);
});

// ── Second round: borrowed from the Korean pipeline + rhetorical questions ──

test('VALIDATION (real service): a rhetorical question word holds for its answer', () => {
  assert.equal(endsDanglingZh('门徒在跟随主的路上他们即使他们在最后的晚餐上什么'), true); // #221 → "…, what"
  assert.equal(endsDanglingZh('我想他一定就flashback到怎么讲'), true); // #138
  assert.equal(endsDanglingZh('这个时候怎么样'), true); // #131
  // CONTROL: a question closed by its particle still ends there.
  assert.equal(looksCompleteZh('那最后约翰福音以什么为结尾呢'), true);
});

test('verse matching: recognises which verse is read, with no verse number spoken', async () => {
  const { matchSpokenVersesZh } = await import('../src/verse-match-zh');
  const v = (s: string) => matchSpokenVersesZh(s, 'John', 21).map((m) => m.verse);
  assert.deepEqual(v('耶稣说这话,指彼得要怎样死荣耀神说了这话就对他说:你跟从我吧'), [19]);
  // Recognition errors (树上袋子 for 束上带子) still match.
  assert.deepEqual(v('实实在在地告诉你,你年少的时候自己树上袋子'), [18]);
  // A segment running across two verses gets both.
  assert.deepEqual(v('耶稣就来拿饼和鱼耶稣从死里复活以后,向门徒显现,这是第三次。'), [13, 14]);
  // The phrase shared by 15-17: only the verse that also has 第三次.
  assert.deepEqual(v('第三次对他说约翰的儿子西门你爱我吗'), [17]);
  // CONTROL: commentary that only mentions the story is not a reading.
  assert.deepEqual(v('我想弟兄姐妹对这段对话其实也是非常的熟悉就是耶稣连续问了彼得三次你爱我吗'), []);
  assert.deepEqual(v('这就是讲到了一个爱主的问题那两年前我们在学习罗马书'), []);
});

test('VALIDATION (real service): a long reading keeps its passage past the timeout', async () => {
  const { keepReadingZh } = await import('../src/verse-match-zh');
  const ref = { book: 'John', chapter: 21, verse: 1 };
  assert.equal(keepReadingZh(ref, '耶稣说这话,指彼得要怎样死荣耀神说了这话就对他说:你跟从我吧'), true);
  assert.equal(ref.verse, 19);
  assert.equal(keepReadingZh(ref, '所以弟兄姐妹我们今天要学习爱主之道'), false);
});

test('translator sends the verse being read — Chinese and English — for a reading', async () => {
  const { ClaudeTranslator } = await import('../src/translation');
  const t = new ClaudeTranslator('test-key', 'test-model', 'zh-en', 'replay', { churchTerms: [] });
  let sent = '';
  (t as unknown as { client: unknown }).client = {
    messages: {
      create: async (req: { messages: { content: string }[] }) => {
        sent = req.messages[0].content;
        return { content: [{ type: 'text', text: 'and someone else will lead you.' }] };
      },
    },
  };
  await t.translate('别人要把你带到你不愿意去的地方', { book: 'John', chapter: 21, verse: 1 });
  assert.match(sent, /John 21:18/);
  assert.match(sent, /束上带子/); // the real Chinese text, for what he skipped
  assert.match(sent, /English \(BSB\)/);
  assert.match(sent, /ONLY the parts he actually spoke/);
});

test('VALIDATION (real service): tag questions are thinned to one in three', async () => {
  const { thinTagQuestionsZh } = await import('../src/text-zh');
  const state = { count: 0 };
  const out = [
    '这些都是应该做的是吧',
    '他们大部分都是渔夫是吧那后来呢',
    '我们会有这样的心理对吧',
    '这就是彼得是吧',
  ].map((t) => thinTagQuestionsZh(t, state));
  assert.equal(out.join('').match(/是吧|对吧/g)?.length, 2, JSON.stringify(out)); // 1st and 4th kept
  assert.equal(out[1], '他们大部分都是渔夫那后来呢');
  // Never touches 是 / 吧 used normally.
  assert.equal(thinTagQuestionsZh('我们一起祷告吧', { count: 1 }), '我们一起祷告吧');
});

test('REGRESSION: a segment that is only a tag question is not emptied', async () => {
  // Emptied, the translator invented "What is that to you? You follow me."
  const { thinTagQuestionsZh } = await import('../src/text-zh');
  assert.equal(thinTagQuestionsZh('是吧', { count: 1 }), '是吧');
});

test('verse matching: a reading that starts in the same breath as its announcement', async () => {
  const { matchSpokenVersesZh } = await import('../src/verse-match-zh');
  const v = matchSpokenVersesZh('接下来的请应经文来自约翰福音二十一章一到二十五节由讲台念单数节请会众念双数节这些事以后耶稣在提比哩亚', 'John', 21);
  assert.deepEqual(v.map((m) => m.verse), [1]);
});
