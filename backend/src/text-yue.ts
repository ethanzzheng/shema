/**
 * Sentence-boundary helpers for Cantonese sermon text (yue-en).
 *
 * Deepgram's zh-HK model returns Traditional characters, mostly converted to
 * written Chinese (我們, 這個, 不過) with colloquial Cantonese left in where it
 * has no written form (喺, 係, 啲, 嘅, 佢哋). So a Cantonese buffer needs both
 * the Mandarin rules (for the written-Chinese parts) and Cantonese ones (for
 * the colloquial parts).
 *
 * Everything here works on text folded to Simplified (zh-script.ts), which
 * maps one character to one character. The word lists below are written in
 * Traditional, as heard, and folded once at load, so the same table matches
 * either script. Offsets found on folded text are offsets in the original.
 */
import { foldToSimplified as fold } from './zh-script';
import {
  endsDanglingZh,
  endsWithStrongTerminatorZh,
  looksCompleteZh,
  splitLastClauseWith,
  splitSentencesZh,
} from './text-zh';

const folded = (xs: string[]): string[] =>
  [...new Set(xs.map(fold))].sort((a, b) => b.length - a.length);

/**
 * Cantonese sentence-final particles. 啦/喇/囉 close a statement, 㗎/喎/噃
 * assert or report, 咩/嗎 ask, 吖/啩/嘛 suggest or hedge. 嘅 is ABSENT: like
 * Mandarin 的 it is far more often the attributive marker before a noun.
 */
const YUE_FINAL_PARTICLES = folded([
  '啦', '喇', '囉', '㗎', '喎', '噃', '咩', '嘛', '吖', '啩', '嘞', '咋', '啫', '咯', '喇嘛', '㗎喇',
  '先', '添', '阿們',
]);

/** A clause ending on 係咁嘅 ("that's how it is") is finished, not attributive. */
const YUE_COMPLETE_RE = [/(?:系|就系)?(?:咁|噉)(?:样)?嘅$/];

/**
 * Trailing words that leave a hole: the head noun, the object, or the main
 * clause is still to come. Longest first after folding.
 */
const YUE_DANGLING = folded([
  // attributive / linking: 嘅 = 的
  '嘅',
  // conjunctions that open a clause
  '因為', '所以', '如果', '但係', '不過', '即係', '就係', '都係', '唔係', '或者', '同埋', '跟住',
  '然之後', '之後', '然後', '嘅話', '嘅時候', '時候', '雖然', '就算', '總之',
  // coverbs awaiting their object
  '喺', '畀', '俾', '將', '對住', '為咗',
  // quotative and mental verbs with their complement still to come
  '講', '覺得', '知道', '諗', '以為', '令到',
  // determiners and classifiers with their noun still to come
  '呢個', '嗰個', '呢啲', '嗰啲', '一啲', '每一個', '呢種', '嗰種',
  // adverbs directly before their verb
  '仲', '好似', '應該', '可以', '其實', '真係',
]);

/**
 * Dangling only when not the end of an ordinary word (on folded text):
 * 同 but not 唔同 (different), 係 but not 關係 (relationship), 話 but not
 * 說話/講話 (speech), 令 but not 命令 (command).
 */
const YUE_DANGLING_RE = [/(?<![有不])可能$/, /(?<![唔共相不])同$/, /(?<![关联体])系$/, /(?<![说讲电笑神])话$/, /(?<![命法指口])令$/];

/**
 * Words that open a new sentence. 咁 alone is too common mid-clause (咁多,
 * 咁樣, 好咁), so it only counts in front of a subject or 就.
 */
const YUE_OPENERS = folded([
  '咁我哋', '咁你', '咁佢', '咁就', '咁大家', '噉我哋', '噉你', '噉就',
  '所以', '但係', '不過', '跟住', '然後', '之後', '其實', '因為', '如果', '當然',
  '弟兄姊妹', '各位', '好喇', '好啦', '今日我哋', '我哋一齊', '大家一齊', '請大家',
]);

/** Tag questions: the preacher's invitation to agree, closing the clause before. */
const YUE_TAGS = folded(['係咪呀', '係咪', '係唔係', '啱唔啱', '對唔對', '好唔好', '吖嘛', '喇嘛']);

/** Ask-then-answer cues: the answer follows in the same breath. */
const YUE_RHETORICAL_CUE = new RegExp(`(?:${folded(['乜嘢', '咩嘢', '點樣', '點解', '邊個', '邊度', '做乜', '乜']).join('|')})$`);

function core(text: string): string {
  return fold(text).trimEnd().replace(/["'”’」』）)]+$/, '').trimEnd();
}

/** The Cantonese holdsForHead: does the buffer end before its meaning is complete? */
export function endsDanglingYue(text: string): boolean {
  const t = core(text);
  if (!t) return false;
  if (endsWithStrongTerminatorZh(t)) return false;
  if (YUE_COMPLETE_RE.some((re) => re.test(t))) return false;
  // 唔同 is "different", not the coverb 同 the Mandarin list holds for.
  if (/唔同$/.test(t)) return false;
  if (endsDanglingZh(t)) return true;
  if (YUE_RHETORICAL_CUE.test(t)) return true;
  return YUE_DANGLING.some((w) => t.endsWith(w)) || YUE_DANGLING_RE.some((re) => re.test(t));
}

export function looksCompleteYue(text: string): boolean {
  const t = core(text);
  if (!t) return false;
  if (endsWithStrongTerminatorZh(t)) return true;
  if (YUE_COMPLETE_RE.some((re) => re.test(t))) return true;
  if (endsDanglingYue(t)) return false;
  return looksCompleteZh(t) || YUE_FINAL_PARTICLES.some((p) => t.endsWith(p)) || YUE_TAGS.some((p) => t.endsWith(p));
}

/** Same terminators as Mandarin; they are not affected by script. */
export const splitSentencesYue = splitSentencesZh;

// Mandarin openers and tags apply to the written-Chinese parts.
const ZH_OPENERS_FOR_YUE = ['弟兄姊妹', '弟兄姐妹', '可是', '但是', '所以', '因此', '然后', '其实', '那么', '另外', '我想', '我们来', '我们一起', '请大家', '因为', '如果', '虽然', '当然', '比如说'];
const ZH_TAGS_FOR_YUE = ['是吧', '对吧', '对不对', '是不是', '好不好'];

export function splitLastClauseYue(text: string, minHead = 6): { head: string; rest: string } | null {
  return splitLastClauseWith(text, minHead, {
    openers: [...new Set([...YUE_OPENERS, ...ZH_OPENERS_FOR_YUE])],
    tags: [...new Set([...YUE_TAGS, ...ZH_TAGS_FOR_YUE])],
    weakFinals: fold('了吗吧啦喇囉㗎喎咩'),
    dangling: endsDanglingYue,
    fold,
  });
}

/** Tag words for thinTagQuestionsZh, as they appear in RAW (unfolded) text. */
export const YUE_TAG_PATTERN = '係咪呀|係咪|系咪|啱唔啱|是吧|对吧|對吧';
