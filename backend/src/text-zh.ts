/**
 * Sentence-boundary helpers for Mandarin Chinese sermon text (zh-en).
 *
 * Mandarin is SVO, so unlike Korean the verb arrives early and most cuts are
 * survivable. The dangerous cuts are different ones:
 *
 *   - Modifiers precede their head noun, joined by 的: "在我们还作罪人的时候
 *     就已经临到我们身上的 | 爱". Cut after the 的 and the English gets a
 *     modifier with nothing to modify — the same meaning-inversion risk the
 *     Korean chunker guards against.
 *   - Coverbs and conjunctions open a clause whose substance comes next
 *     (把/被/对/给/因为/如果/虽然/不是…而是…). Cut there and the English has
 *     a preposition or a "because" hanging in the air.
 *   - A scripture citation split across STT finals: Deepgram was observed
 *     emitting "约翰福音第" and "3章16节" as SEPARATE finals.
 *
 * Two practical differences from the Korean helpers: Chinese has no spaces, so
 * a sentence end is 。！？ directly followed by the next character; and the
 * recogniser emits a mix of full-width (，。) and half-width (, ?) punctuation,
 * so both are handled everywhere.
 */

/** Sentence-final punctuation, full- and half-width. ASCII '.' is excluded: in
 *  Mandarin output it only appears inside numbers ("3.16"). */
const ZH_TERMINATORS = '。！？!?…';
const CLOSERS = `"'”’」』）)`;

/**
 * Sentence-final particles. A buffer ending here is a finished utterance:
 * 吗/呢/吧 close a question or suggestion, 啊/呀/哦/嘛 close an exclamation,
 * 了 marks completion. 的 is deliberately ABSENT — it is far more often the
 * attributive marker that precedes a head noun (see ZH_DANGLING).
 */
const ZH_FINAL_PARTICLES = ['吗', '呢', '吧', '啊', '呀', '哦', '嘛', '了', '阿们', '阿门'];

/**
 * Trailing tokens that leave a syntactic hole: the head noun, the object, or
 * the main clause has not arrived yet. Shipping a buffer that ends on one of
 * these is what produces a dangling English modifier or a stranded "because".
 * Longest entries first so multi-character conjunctions win over their tails.
 */
const ZH_DANGLING = [
  // conjunctions that open a clause
  '因为', '所以', '如果', '虽然', '但是', '可是', '而且', '而是', '不是', '就是', '还是',
  '或者', '甚至', '只要', '除非', '无论', '不管', '既然', '即使', '不但', '不仅',
  '然后', '于是', '并且', '以及', '因此', '尤其是',
  // coverbs / prepositions awaiting their object
  '把', '被', '对', '给', '跟', '和', '与', '同', '从', '向', '往', '为了', '为', '让', '叫',
  '将', '于', '以', '在', '比', '连', '靠着', '通过', '关于', '对于', '按照', '根据',
  // attributive / adverbial markers awaiting their head
  '的', '地',
  // an ordinal or quantity with its noun still to come ("第" + "3章")
  '第', '这个', '那个', '一个', '每一个',
  // verbs that introduce a quotation or a complement
  '说', '说过', '告诉我们', '认为', '觉得', '知道', '希望', '是',
  // subordinate clauses whose main clause is still to come: "…的时候" (when),
  // "…的话" (if), "在…当中" (in). The first real service cut at all three.
  '的时候', '时候', '的话', '之后', '以后', '之前', '当中',
  // linkers and comparisons that announce what follows
  '这样才', '就像', '好像', '比如说', '比如', '例如', '也就是说', '也就是', '包括', '接下来',
  '至于', '而', '并', '那么', '只是', '只有', '除了', '不只是', '甚至是',
  // adverbs that sit directly before their verb
  '就', '也', '都', '还', '又', '再', '却', '更', '最', '很', '非常', '一直', '常常', '总是',
  '已经', '正在', '曾经', '不断的', '不断地',
  // modal verbs awaiting the verb they govern
  '能够', '可以', '应该', '应当', '愿意', '必须', '想要', '敢',
  // light verbs whose real content is the object still to come: "…进行了 |
  // 一个对比" was cut live, the model supplied "contrasted" from nowhere and
  // the next segment then repeated "a contrast".
  '进行了', '进行', '作出了', '做出了', '作出', '做出', '发出了', '发出', '给予', '加以',
  '带来了', '成为了', '成为', '变成了', '变成', '叫做', '称为', '当作', '看作',
  // a classifier with its noun still to come ("这是一种 | 爱")
  '一种', '一位', '一些', '这种', '那种', '这样的', '那样的', '一份',
];

/**
 * Trailing characters that are dangling ONLY when they are not the end of an
 * ordinary word: 会 is "will" but also 教会/聚会 (church, meeting), 要 is
 * "must" but also 重要 (important), 像 is "like" but also 偶像 (idol), 才 is
 * "only then" but also 刚才 (just now).
 */
const ZH_DANGLING_RE = [
  /(?<![教聚大机开学社体协理议宴晚约])会$/,
  /(?<![重主必纲摘紧需只])要$/,
  /(?<![图偶影画肖雕想])像$/,
  /(?<![刚人方])才$/,
  /(?<![可才功本])能$/,
];

/**
 * 呢 is a question particle only when the clause asks something. Far more
 * often in a sermon it marks a topic mid-sentence — "今天的经文当中呢，…"
 * ("in today's passage, …"), "爱主呢" ("as for loving the Lord, …") — and
 * shipping there left the translator to invent the rest: a bare 爱主呢 came
 * out as "Do they really love the Lord?".
 */
const ZH_QUESTION_WORDS = /什么|怎么|怎样|为什么|为何|谁|哪|多少|几|如何|是不是|有没有|对不对|要不要|会不会|能不能|还是|难道|吗/;

/**
 * A preacher's ask-then-answer: "第三节说什么？西门彼得对他们说…", "这个时候
 * 怎么样？…". A bare question word with no particle is the cue, and the answer
 * follows in the same breath. Cut there and the English is a stranded "what"
 * ("even at the Last Supper, what") — 8 of 261 segments in the first real
 * service ended this way.
 */
const ZH_RHETORICAL_CUE = /(?:什么|怎么样|怎么讲|怎么说|怎样|为什么|在哪里|是谁)$/;

/** Vocatives in prayer: "主啊" opens a petition, it does not end one. */
const ZH_VOCATIVE = /(?:主|神|天父|父|上帝|耶稣|圣灵|父神|主耶稣)(?:啊|呀|阿)$/;

/** The clause the buffer ends on: everything after the last comma or stop. */
function lastClause(t: string): string {
  const i = Math.max(...[...'，,。！？!?；;'].map((c) => t.lastIndexOf(c)));
  return t.slice(i + 1);
}

/** Ends on 呢 as a topic marker rather than a question. */
export function endsOnTopicMarkerZh(text: string): boolean {
  const t = coreEnd(text);
  return t.endsWith('呢') && !ZH_QUESTION_WORDS.test(lastClause(t).slice(0, -1));
}

/** Strip trailing whitespace and closing quotes/brackets. */
function coreEnd(text: string): string {
  let t = text.trimEnd();
  let end = t.length;
  while (end > 0 && CLOSERS.includes(t[end - 1])) end--;
  return t.slice(0, end).trimEnd();
}

export function endsWithStrongTerminatorZh(text: string): boolean {
  const t = coreEnd(text);
  return t.length > 0 && ZH_TERMINATORS.includes(t[t.length - 1]);
}

/** Ends on a clause comma (full- or half-width) — explicitly mid-thought. */
export function endsWithCommaZh(text: string): boolean {
  return /[，,、；;：:]$/.test(coreEnd(text));
}

/**
 * A scripture citation whose verse number has not been spoken yet — the
 * Mandarin twin of the Korean incomplete-reference hold. Covers "约翰福音第",
 * "约翰福音第三章", "约翰福音3章", and a bare book name.
 */
export function endsWithIncompleteReferenceZh(text: string): boolean {
  const t = coreEnd(text).replace(/[，,。]$/, '');
  if (!t) return false;
  if (/第$/.test(t)) return true;
  if (/(?:\d+|[零〇一二两三四五六七八九十百]+)\s*章$/.test(t)) return true;
  if (/(?:福音|书|记|纪|篇|传|录|歌|言|哀歌|[上下]|[一二三]书)$/.test(t) && t.length <= 8) return true;
  return false;
}

/**
 * Does the buffer end on a token that needs more speech to make sense? This is
 * the Mandarin `holdsForHead`: the chunker gives such a buffer extra patience,
 * and when patience runs out it ships only a safe prefix.
 */
export function endsDanglingZh(text: string): boolean {
  const t = coreEnd(text);
  if (!t) return false;
  if (endsWithStrongTerminatorZh(t)) return false;
  if (endsWithCommaZh(t)) return true;
  if (endsWithIncompleteReferenceZh(t)) return true;
  if (endsOnTopicMarkerZh(t) || ZH_VOCATIVE.test(t) || ZH_RHETORICAL_CUE.test(t)) return true;
  return ZH_DANGLING.some((w) => t.endsWith(w)) || ZH_DANGLING_RE.some((re) => re.test(t));
}

/**
 * A high-confidence complete sentence: terminal punctuation, or a
 * sentence-final particle with nothing dangling after it.
 */
export function looksCompleteZh(text: string): boolean {
  const t = coreEnd(text);
  if (!t) return false;
  if (endsWithStrongTerminatorZh(t)) return true;
  if (endsDanglingZh(t)) return false;
  return ZH_FINAL_PARTICLES.some((p) => t.endsWith(p));
}

/**
 * Split into complete sentences plus a trailing remainder. Unlike the Korean
 * and English splitters this does NOT require whitespace after the terminator
 * — Chinese has none, and requiring it returned zero sentences for any real
 * Mandarin buffer.
 */
export function splitSentencesZh(text: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!ZH_TERMINATORS.includes(text[i])) continue;
    let end = i + 1;
    while (end < text.length && (ZH_TERMINATORS.includes(text[end]) || CLOSERS.includes(text[end]))) end++;
    const seg = text.slice(start, end).trim();
    if (seg) sentences.push(seg);
    start = end;
    i = end - 1;
  }
  return { sentences, remainder: text.slice(start).trim() };
}

/**
 * Words that open a new sentence in spoken Mandarin. When the recogniser emits
 * little punctuation — one of two test voices got almost none — these are the
 * remaining evidence of where one thought ends and the next begins.
 */
const ZH_SENTENCE_OPENERS = [
  '弟兄姊妹', '弟兄姐妹', '可是', '但是', '所以', '因此', '然后', '其实', '那么', '另外',
  '我想', '我们来', '我们一起', '请大家', '今天我', '好，', '好,',
  '因为', '如果', '虽然', '当然', '比如说', '我们看到', '我们就看到', '那我们', '那今天',
];

/** Tag questions close the sentence before them: "…是不是很难是吧" | "那…". */
const ZH_TAGS = ['是吧', '对吧', '对不对', '是不是', '好不好', '对不对啊'];

/**
 * When patience runs out on a dangling buffer, ship the longest prefix that
 * ends at a safe boundary — a clause comma, a sentence-final particle, or just
 * before a sentence-opening word — and keep the rest buffered. Returns null
 * when there is no such cut.
 *
 * Commas alone were not enough: a run-on with no punctuation reached the hold
 * cap, found no comma, and shipped whole while ending on the coverb 在 — the
 * translator then finished the sentence itself.
 */
export function splitLastClauseZh(text: string, minHead = 6): { head: string; rest: string } | null {
  const t = text.trim();
  // Strong cuts: a clause comma, the end of a tag question, or just before a
  // word that opens a new sentence.
  const strong = new Set<number>();
  for (let i = 0; i < t.length; i++) if ('，,；;'.includes(t[i])) strong.add(i + 1);
  for (const w of ZH_TAGS) {
    for (let i = t.indexOf(w); i !== -1; i = t.indexOf(w, i + 1)) strong.add(i + w.length);
  }
  for (const w of ZH_SENTENCE_OPENERS) {
    for (let i = t.indexOf(w, 1); i !== -1; i = t.indexOf(w, i + 1)) strong.add(i);
  }
  // Weak cuts, used only when no strong one works: after a sentence-final
  // particle. Weak because 了 is just as often the verb suffix in the middle
  // of a clause ("回到了 | 加利利", "returned to | Galilee"). Never 呢 or 啊:
  // in running speech those are a topic marker or a vocative as often as an
  // ending.
  const weak = new Set<number>();
  for (let i = 0; i < t.length; i++) {
    if ('了吗吧'.includes(t[i]) && i + 1 < t.length && !'，,。'.includes(t[i + 1])) weak.add(i + 1);
  }
  for (const cuts of [strong, weak]) {
    const ordered = [...cuts].sort((a, b) => b - a);
    for (const at of ordered) {
      if (at < minHead || at >= t.length) continue;
      const head = t.slice(0, at).trim();
      const rest = t.slice(at).trim();
      const core = head.replace(/[，,；;]$/, '');
      if (rest.length > 0 && !endsDanglingZh(core)) return { head, rest };
    }
  }
  return null;
}

/**
 * 是吧 / 对吧 are always tag questions — the pastor's tic inviting a nod — and
 * a Mandarin preacher can say one every few sentences. Prompt guidance alone
 * did not thin them: 27 tags in one sermon came out as 25 "right?"s. So they
 * are thinned before translation: every `keepEvery`-th one survives (as an
 * appeal the English can render), the rest are removed. `state.count` carries
 * the running count across segments.
 */
export function thinTagQuestionsZh(text: string, state: { count: number }, keepEvery = 3): string {
  // A segment that is ONLY a tag stays: emptied, the translator was left with
  // nothing to translate and invented a Bible line from the context instead.
  if (/^\s*(?:是吧|对吧)[，,。？?！!]?\s*$/.test(text)) {
    state.count++;
    return text;
  }
  return text.replace(/(是吧|对吧)([，,。？?！!]?)/g, (m, _tag, punct: string) => {
    state.count++;
    if (state.count % keepEvery === 1) return m;
    // Keep a sentence end the tag was carrying; drop a comma.
    return /[。？?！!]/.test(punct) ? '。' : '';
  });
}
