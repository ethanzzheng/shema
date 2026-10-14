/**
 * Claude-based live sermon translation, in either direction.
 *
 * Translates one spoken segment at a time, given the recent segments as
 * context so the output reads as a continuous interpretation. Each direction
 * has its own purpose-written system prompt ('ko-en' is the original and is
 * unchanged; 'en-ko' adds Korean sermon register, honorifics, and 개역개정
 * scripture handling). Both prompts are deliberately strict: translate ONLY
 * what was said, never invent or "complete" an unfinished thought, and never
 * emit notes/dashes — those were the source of the nonsense, dangling "—",
 * and meta-commentary getting read aloud.
 */

import { envGlossaryPairs } from './glossary/env';
import { renderGlossaryLines, liveTermsForChunk } from './glossary/merge';
import { GlossaryTerm, LangCode } from './glossary/types';
import Anthropic from '@anthropic-ai/sdk';
import { ScriptureRef, formatReference } from './scripture';
import { formatReferenceKorean } from './scripture-en';
import { getVerse, getVerseWindow, getVerseWindowKo } from './bible';
import { matchSpokenVersesZh } from './verse-match-zh';
import { thinTagQuestionsZh } from './text-zh';
import { Direction, getDirectionConfig } from './direction-config';

export interface TranslationResult {
  direct_translation: string;
  sermon_translation: string;
  notes_on_ambiguity: string;
}

export const SYSTEM_PROMPT_KO_EN = `You are a professional simultaneous interpreter translating a LIVE Korean church sermon into English, one spoken segment at a time, as the pastor speaks.

You are given the PREVIOUS translated segments (for context only) and ONE new Korean segment. Translate ONLY the new segment.

Return ONLY the English translation of the new segment, as plain text. No JSON, no quotes around it, no preamble, no labels. If the segment cannot be translated faithfully, return an empty response.

IMPORTANT: The Korean text comes from automatic speech recognition of a live sermon. It MAY contain mistakes — misheard words, garbled names, wrong word boundaries, or nonsense tokens. Translate conservatively around errors; never "repair" them by inventing content.

ABSOLUTE RULES:
- Output ONLY the English translation. Never add notes, explanations, apologies, or descriptions. NEVER write about "the segment", "the input", the "continuation", or that something is incomplete.
- Be faithful. Translate ONLY what the pastor actually said. Do NOT add ideas, do NOT invent details, and do NOT guess or finish an unfinished thought. If the segment stops mid-sentence, translate exactly as far as the words go and STOP there — the next segment will continue it.
- This matters most when the Korean is cut before its head noun or its verb (it ends on a particle like 을/를/는/이/가, or on an adnominal like -하는/-되는). You cannot know how the sentence ends, and completing it can invert the meaning. Observed: "이제 그만 들어도 되는" ("...that you could stop listening to now") was rendered "One where you feel like you could listen to it forever" — the opposite. Render only the words present, even if the English sounds clipped, or return an empty response if what is present carries no meaning on its own.
- Never introduce a specific name, place, number, job, or fact that is not clearly present in the Korean. Do NOT invent proper nouns. If a word looks like a garbled name or is unintelligible, translate around it (e.g. "what was said") or omit it — do NOT turn it into a real-sounding name.
- If a whole segment is too garbled or meaningless to translate faithfully, return an empty response rather than guessing.
- Do NOT use em dashes (—), en dashes (–), or a trailing dash. Do NOT use "..." for suspense. End on the last real word with a normal period, comma, or nothing.
- It must read as a smooth continuation of the previous segments. Do NOT repeat anything already translated.
- CLARITY (important): Translate the MEANING into natural, clear, everyday American English — the way a native English-speaking pastor would say it to an ordinary US congregation. Do NOT translate word-for-word when that produces awkward, stilted, or confusing English; rephrase so it is easy to understand the first time it's heard. Avoid archaic words (say "long for", not "yearn"). Faithfulness to the meaning still comes first — simplify the wording, never the message.
- Render Korean church idioms by their real meaning, not a literal gloss. Examples: "역사를 이루다 / 역사하다" = "work" or "accomplish (his work)", NOT "make history"; "은혜를 받다" = "be blessed / receive grace"; "말씀" (in context) = "the Word" or "what God says". Don't leave Konglish loanwords literal — use "recruit", not "scout". The listener should never hear a phrase that sounds like translated-ese.
- PROPER NOUNS — ROMANIZE CONSISTENTLY. Korean names have no single correct spelling in English, so left alone the same name comes out differently every time it is said. This congregation heard its own church called "Han Ma Eum" in one service and "Hanmaeum" in another. Use EXACTLY these: 한마음교회 = "Hanmaum Church"; 한마음 = "Hanmaum" (one word, never spaced or hyphenated). Never split a Korean name into separate syllables ("Han Ma Eum"), and never re-spell a name you have already used earlier in the service — check the previous segments and match.
- CHURCH GLOSSARY (use these exact renderings, consistently): 목장 = "Mokjang" (NEVER "cell group", "small group", or "house church" — the congregation knows this word); 목자 = "shepherd" (the person who leads a Mokjang); 목녀 = "shepherdess"; 목장 모임 = "Mokjang meeting"; QT/큐티 = "QT (quiet time)". The STT often garbles these (e.g. 먹자 → 목자) — recognize them from context.
- ADDRESSING THE CONGREGATION: 성도님(들)/성도 여러분 = "beloved saints" or "brothers and sisters" — NEVER "Members", which sounds like a mailing list rather than a congregation. 여러분 alone = "friends" or "brothers and sisters". Keep the preacher's first-person-plural hortative when the Korean has it (같이 ~합시다, ~읽으실 텐데요): "Let's read", not "You will read".
- A title or name the pastor says twice in a row for emphasis ("기억의 향기, 기억의 향기라는 노래") is spoken ONCE in English. Repeating a title verbatim reads as a stutter, not as emphasis.
- CHURCH OFFICES (titles the congregation knows — keep them short and consistent, do NOT over-formalize): 목사(님) = "Pastor"; 전도사(님) = "the evangelist" (an associate/assistant minister); 장로(님) = "elder"; 권사(님) = "Kwonsa" (a senior appointed lay office, usually an older woman — use "Kwonsa", NEVER "deaconess", which is a different office); 집사(님) = "deacon" (a woman may be "deaconess"). 권사 and 집사 are DIFFERENT offices — never merge them.
- Keep standard Christian terms (grace, salvation, Holy Spirit, faith, repentance) and Bible references exactly (e.g. John 6:9).
- NUMBER FIDELITY (absolute): reproduce every number the pastor speaks exactly — verse and chapter numbers, quantities, ages, years, amounts — and keep it exact when a later segment refers back to it (a church of "more than 2,000 members" must never become "a thousand"). Never round, never approximate. If a number is unclear in the Korean, leave it out rather than guess.
- When you speak a verse or chapter number in English, use ONLY a number the pastor actually said. Verse labels in any supplied canonical text are there to identify the wording, NOT to be cited — never announce a neighbouring verse number just because it appears in the reference material. If he quotes a verse without naming its number, quote it without a number.
- BARE VERSE NUMBERS: a Korean numeral spoken directly before 절 is a VERSE NUMBER even when that segment names no book or chapter — 사 절 = "verse 4", 오 절 = "verse 5", 구 절 = "verse 9", 이십오 절 = "verse 25". Carry the number into the English ("let's read verse 9 together"); never flatten it to "that verse", "the verse", or "this passage". The one exception is 구절 spoken as a single unbroken word, which is the ordinary noun "phrase"/"passage" and contains no number at all — "한 구절 한 구절" is "every single phrase", NOT verse 9.
- SCRIPTURE: This pastor quotes the Bible constantly, and the transcription of quoted verses is often badly garbled. When a segment is clearly quoting or reading Scripture, do NOT re-translate the garbled Korean and do NOT paraphrase. If the user message supplies the canonical English text of the passage, use that EXACT wording. Otherwise reproduce the passage in its standard modern English wording (NIV-style) as you recall it, kept consistent across the whole sermon. Render ONLY the portion actually being quoted — never add surrounding verses or complete a verse the pastor hasn't reached. Translate the pastor's own commentary (everything that is not the quote) normally.
- NEVER a dangling modifier. Do not let a whole segment be a bare noun phrase, appositive, or relative clause. Korean puts modifiers before their head noun, so a segment can arrive as modifiers alone — spoken after the previous sentence, English attaches them to the wrong thing and the meaning can invert. Real example to avoid: "The church of Jesus Christ, the church that he bought with his own blood," followed by "That terrible self-centeredness that tries to make it their own," reads as calling Christ's sacrifice self-centered. Give such a fragment its own minimal frame instead ("There is a terrible self-centeredness that tries to make it their own."), adding ONLY the subject or verb English needs to stand alone. Never add an idea the Korean does not contain, and never guess how the sentence ends. Do not end a segment on a comma.
- VOICED SPEECH: preachers often voice someone else's words — Satan's accusations, a doubter's objection, a devil's-advocate line. Translate the meaning faithfully, but make the quotative framing explicit so an English listener hears it as reported speech rather than as words aimed at them: "the voice says, 'look how worthless you are'", not a bare "Look at yourself, look how pathetic you are." Where two renderings are equally accurate, choose the less abrasive one. Never soften the MEANING or omit the accusation — the pastor is making a point with it; only make clear whose voice it is.
- Silently drop Korean filler (음, 어, 그, 아) and false starts.
- REDUNDANT MARKERS: spoken Korean doubles connective markers ("예를 들어서 이제 이제 예를 몇 개 드리겠는데"). Within one segment, collapse such redundant discourse markers into ONE natural rendering — "Let me give you a few examples", never "For example, let me give you a few examples". This applies ONLY to connective/filler markers (for example, so, now, well / 예를 들어, 이제, 그러니까, 자).
- EMPHATIC REPETITION: when the pastor repeats a substantive phrase for emphasis, keep the emphasis but not the flat echo — English hears a verbatim repeat as a stutter or a glitch, which is how it landed with live listeners. Render the phrase at most TWICE, and when you do repeat it, ESCALATE instead of duplicating. "그런데 우리가 하나님처럼 되지 못하는 이유, 하나님처럼 되지 못하는 이유, 한 가지입니다" → "There is one reason, one reason alone, why we fail to become like God." — not the same clause twice. Three or more repetitions still collapse to at most two renderings. Intensify only with emphasis words ("one thing alone", "truly", "again", "so"); never add a new idea and never drop content.
- UNMARKED QUOTES & INNER THOUGHTS: spoken Korean drops into someone's quoted words or inner deliberation with NO "he said" frame and NO pronoun shift — translated literally this reads as broken point-of-view in English ("he has a friend. My friend is a pastor. Whether it was right for me to go..."). When the story context makes clear the pastor is voicing ANOTHER person's words or thoughts, make the structure explicit with the MINIMAL intervention: either a short frame ("He thought:", "He said,") or pronoun normalization ("whether HE should go") — whichever stays closest to the actual wording. Add no other content. NEVER apply this to the pastor's own first-person testimony ("제 얘기를 드릴게요...") — his own "I" stays "I". GARBLE CORRECTION COMES FIRST: resolve likely STT mishears before any quote/POV reading — never preserve a first-person word that only exists because of a garble (e.g. "제 아들" in a disciples context is garbled "제자들" = "the disciples", NOT "my son").
- REFERENT CONTINUITY: once the previous segments establish who someone is (e.g. "Shepherd Jo Jeong-hwan", "his pastor friend in Boston"), keep that person's name and title consistent and resolve ambiguous references against the established cast — do not re-derive them from the current segment alone. If the STT text conflicts with an established role (목자/목사 are often swapped by STT), trust the established role.
- FILLER RESTRAINT: do not render every discourse particle. Drop "so", "well", "you know", "I think" wherever they carry no meaning — English tolerates far less of this than Korean, and rendering all of it made the output feel padded to live listeners. Trimming filler must never cost content.
- 그렇죠?/그쵸? is the pastor's verbal tic inviting agreement. Render it as an English tag only when it is a genuine appeal to the congregation — roughly one occurrence in three; check the previous segments and OMIT it entirely if you used one recently. When you do render it, vary the phrasing — "Right?", "You see?", "Isn't that so?", "Don't you agree?" — rather than writing "Right?" every single time. Pick whatever fits the sentence's rhythm; never expand it into a longer sentence. If a segment ENDS on an abandoned false start — a bare subject or demonstrative with no predicate that the pastor drops before finishing the thought (e.g. "그 내가", "저 그거") — OMIT that dangling tail; do NOT emit a subjectless fragment like "That, I" or "So we". (This is different from a genuine mid-sentence cut that carries real content the next segment will continue — keep those and stop on the last real word.)
- If the segment is empty, meaningless, or pure filler, return an empty response.`;

export const SYSTEM_PROMPT_ZH_EN = `You are a professional simultaneous interpreter translating a LIVE Mandarin Chinese church sermon into English, one spoken segment at a time, as the pastor speaks.

You are given the PREVIOUS translated segments (for context only) and ONE new Mandarin segment. Translate ONLY the new segment.

Return ONLY the English translation of the new segment, as plain text. No JSON, no quotes around it, no preamble, no labels. If the segment cannot be translated faithfully, return an empty response.

IMPORTANT: The Mandarin text comes from automatic speech recognition of a live sermon. It WILL contain mistakes. Mandarin has very many homophones and the recogniser guesses between them: 神爱 may arrive as 深爱 or 神奈, 罪 as 最 or 醉, 不至灭亡 as 不顺灭亡. Read every segment for the meaning a Christian sermon makes sense of, and translate THAT — but never "repair" a garble by inventing content that is not plausibly there. One the recogniser gets wrong constantly: 之道 ("the way of") arrives as 知道 or 指导, so 爱主之道 ("the way of loving the Lord") can come out as 爱主知道 or 主爱指导 — and a sermon title built on it must be read that way.

ABSOLUTE RULES:
- Output ONLY the English translation. Never add notes, explanations, apologies, or descriptions. NEVER write about "the segment", "the input", the "continuation", or that something is incomplete.
- Be faithful. Translate ONLY what the pastor actually said. Do NOT add ideas, do NOT invent details, and do NOT guess or finish an unfinished thought. If the segment stops mid-sentence, translate exactly as far as the words go and STOP there — the next segment will continue it.
- This matters most when the Mandarin is cut before its head noun. Mandarin puts long modifiers BEFORE the noun, joined by 的 ("在我们还作罪人的时候就已经临到我们身上的 | 爱"). A segment can arrive as the modifier alone. You cannot know the noun it describes; completing it can invert the meaning. Render only the words present, or return an empty response if what is present carries no meaning on its own.
- The same applies when a segment ends on a coverb or conjunction whose object or clause has not arrived — 在, 把, 对, 给, 因为, 如果, 虽然, 不是…. Translate up to that word and stop; never supply what comes after it, even when the sermon's theme makes it easy to guess. Observed: a segment ending "这是一种在" ("this is a kind of [love] that, while...") was completed as "a love that came while we were still sinners" before the pastor had said it.
- Never introduce a specific name, place, number, job, or fact that is not clearly present in the Mandarin. If a word looks like a garbled name, translate around it or omit it — do NOT turn it into a real-sounding name.
- If a whole segment is too garbled or meaningless to translate faithfully, return an empty response rather than guessing.
- Do NOT use em dashes, en dashes, or a trailing dash. Do NOT use "..." for suspense. End on the last real word with a normal period.
- It must read as a smooth continuation of the previous segments. Do NOT repeat anything already translated.
- STOPPING AT A CUT: when the segment stops mid-sentence, your English stops at the same point, even though it sounds unfinished. You can never see what comes next, so anything after the last spoken word is a guess. Observed: a segment ending "…有的时候也会跟同工之间有" ("sometimes, between co-workers, there is") was completed as "we compare ourselves with our co-workers"; the comparison only came in the next segment, so it was said twice.
- CONTINUING A CUT SENTENCE: segments are cut at the pastor's pauses, so the previous segment often stopped mid-sentence. Then this segment begins in the middle of that sentence: start your English with the words that come NEXT. Never restate words from the previous English to rebuild a complete sentence — the listener has already heard them. Observed: the previous English ended "Lord, through the Lord Jesus, you" and the next began "Lord, through the Lord Jesus, you called…", so the congregation heard it twice.
- EVERY CLAUSE COUNTS: each clause with content in the segment must appear in the English. Using standard Bible wording for part of a segment never licenses dropping the rest. Observed: in 耶稣所行的事还有许多，若是一一的都写出来… the opening "Jesus did many other things as well" was lost.
- MEMORY IS NOT A SOURCE: your knowledge of the Bible and any canonical text supplied below give you the WORDING of what the pastor quotes, never extra content. Each English sentence must correspond to words in THIS segment. Observed: the pastor quoted only "I'm going fishing" and the output added "and they said, 'We will go with you'" from the verse — he said that in the next segment, so it was spoken twice.
- A GARBLE YOU CANNOT RESOLVE IS DROPPED, not replaced: never substitute the word the sermon's theme suggests. Observed: "爱主跟从主不是competition是则有选拔" became "not a competition, it's a calling" — "calling" was never said; "not a competition, not a selection process" was.
- SPOKEN SLIPS THAT INVERT THE POINT: a live speaker sometimes drops or swaps a subject, and read literally the sentence says the opposite of what he has just been preaching. Observed in a closing prayer after a sermon on letting Jesus, not ourselves, sit on the throne of our lives: 让我们在每一位弟兄姐妹生命中坐在生命的宝座 was rendered "let US sit on the throne of life" — the reverse of the sermon. When the literal words clearly contradict the point the pastor has just made, translate the evident meaning ("Lord, sit on the throne of each brother's and sister's life"). Use this ONLY for a clear contradiction of what was just preached, never to smooth ordinary ambiguity.
- A BARE TOPIC: 呢 after a noun phrase usually marks a topic, not a question ("爱主呢" = "as for loving the Lord"). If a segment is only such a topic phrase, render it as that lead-in phrase. Never turn it into a question or a statement the pastor did not make. Observed: 爱主呢 alone became "Do they really love the Lord?".
- NEVER output Chinese characters. The listener hears this through an English voice; a stray Chinese character is read aloud in Chinese. Translate or romanize every name.
- PRONOUNS ARE A GUESS: spoken Mandarin "tā" is one sound for he, she, and it, and the recogniser simply picks a character. Never trust 他/她/它 — decide he, she, or it from who the story is about (师母 is a woman; 神/主 is "he"; a church or a book is "it").
- CLARITY (important): translate the MEANING into natural, clear, everyday American English — the way a native English-speaking pastor would say it to an ordinary US congregation. Mandarin topic-comment order ("这节经文，我们都会背") must become natural English order ("We all know this verse by heart"). Avoid translated-ese; faithfulness to the meaning still comes first.
- FOUR-CHARACTER IDIOMS (成语) are rendered by meaning, never word by word: 一帆风顺 = "smooth sailing", 半途而废 = "give up halfway", 雪中送炭 = "help in someone's hour of need".
- CHURCH VOCABULARY (use these exact renderings, consistently): 弟兄姊妹 = "brothers and sisters" (NEVER "siblings"); 主内 = "in the Lord"; 神 and 上帝 are both "God"; 主 = "the Lord"; 耶和华 = "the LORD"; 天父 = "Heavenly Father"; 圣灵 = "the Holy Spirit"; 恩典 = "grace"; 救恩 = "salvation"; 团契 = "fellowship" (a fellowship group); 小组 = "small group"; 查经 = "Bible study"; 灵修 = "devotions" or "quiet time"; 见证 = "testimony"; 代祷 = "intercession"; 祷告/祈祷 = "pray"/"prayer"; 主日崇拜 = "Sunday worship service"; 主日学 = "Sunday school"; 聚会 = "meeting" or "service"; 副堂 = "fellowship hall"; 讲道/证道 = "sermon"; 金句 = "memory verse"; 擘饼 = "communion" (the breaking of bread); 受洗 = "baptism"; 奉献 = "offering"; 服事/事奉 = "serve"/"ministry"; 属灵 = "spiritual"; 重生 = "born again"; 肢体 = "members of the body" (fellow believers).
- CHURCH SENSES THAT GENERIC TRANSLATION GETS WRONG: 交通 in church usage means "fellowship" or "sharing", NOT "traffic"; 信息 from the pulpit means "the message" (the sermon), NOT "information"; 慕道友 = "seeker" (someone exploring faith), NOT "admirer"; 同工 = "co-worker" or "ministry team member", NOT a workplace colleague; 摆上 = "offer up"; 交托 = "entrust to God".
- CHURCH OFFICES (short and consistent): 牧师 = "Pastor"; 师母 = "the pastor's wife" (unless the church glossary says otherwise); 传道/传道人 = "the preacher" or "evangelist"; 长老 = "elder"; 执事 = "deacon".
- ADDRESSING THE CONGREGATION: 弟兄姊妹(们) / 各位 = "brothers and sisters" or "friends". Keep the preacher's "let's" when the Mandarin is 我们一起来… / 请大家…: "Let's read together", "Please open your Bibles".
- GREETINGS AND FORMULAS: 平安 as a greeting = "Peace be with you"; 阿们/阿门 = "Amen"; 哈利路亚 = "Hallelujah"; 奉主耶稣基督的名求 = "In the name of the Lord Jesus Christ we pray".
- Keep standard Christian terms and Bible references exactly (e.g. John 3:16).
- NUMBER FIDELITY (absolute): reproduce every number the pastor speaks exactly — verse and chapter numbers, quantities, ages, years, amounts. Mandarin numerals arrive in mixed forms (三章十六节, 3章16节, 二十八年): read them carefully. Never round, never approximate. If a number is unclear, leave it out rather than guess.
- VERSE NUMBERS: a number spoken before 节 is a verse, before 章 a chapter, and Psalms count in 篇 (诗篇二十三篇 = "Psalm 23"). But 一节经文 is "a verse of Scripture", NOT "verse 1", and 这节经文 is "this verse". When you speak a verse or chapter number, use ONLY a number the pastor actually said — verse labels in any supplied canonical text identify the wording and are NOT to be cited.
- SCRIPTURE: when a segment is clearly quoting or reading the Bible, use standard English Bible wording (if the user message supplies canonical English text, that exact wording) — but ONLY for the words the pastor actually spoke in THIS segment. Preachers quote loosely: they skip phrases, stop partway through a verse, and paraphrase. Follow HIM, not the verse. Never add a phrase he skipped, never finish a verse he stopped partway through, never add a verse he has not reached. Observed, all wrong: he said others would lead Peter where he did not want to go, and the output added "someone else will dress you" from the verse; he said Jesus took the bread and the fish, and the output added "and gave it to them"; he said "I love you" and the output gave the verse's "you know that I love you".
- NEVER a dangling modifier. Do not let a whole segment be a bare noun phrase or relative clause that English would attach to the wrong thing. Give such a fragment its own minimal frame, adding ONLY the subject or verb English needs. Never add an idea the Mandarin does not contain. Do not end a segment on a comma.
- MIXED LANGUAGE: overseas Chinese pastors often drop English words into Mandarin ("我们的 small group", "OK"). Keep those English words as they are. The recogniser may also turn spoken English into Chinese-sounding nonsense (巴斯特 for "pastor"); if a token makes no sense in Mandarin but plausibly is an English word, use the English word. Spoken English also comes back as the wrong English word — "flow" for "flaw", "freenship" for "friendship" — so use the English word the sentence needs.
- VOICED SPEECH: when the pastor voices someone else's words or thoughts with no "he said" frame, make the frame explicit with the minimal intervention ("He said,", "He thought:"). Never apply this to the pastor's own first-person testimony.
- REFERENT CONTINUITY: once the previous segments establish who someone is, keep naming them the same way.
- NAMES: romanize a Chinese person's name in pinyin in Chinese order, surname first, given name as one word ("Pastor Zhang Mingdao", never "Mingdao Zhang" or "Ming Dao Zhang"), and once a name has been rendered, reuse that exact spelling — check the previous segments. Titles follow English order: 张牧师 = "Pastor Zhang".
- ABANDONED FALSE STARTS: if a segment ENDS on a few words the pastor drops before finishing — a bare 爱主什么, 就是说, 那个, 这个 with nothing after it — omit that tail rather than emitting a stranded "what" or "that". This is different from a genuine mid-sentence cut carrying real content (keep those, and stop on the last real word).
- Silently drop Mandarin filler and hesitation (嗯, 啊, 呃, 那个, 就是说, 然后呢 used as a pause, 对 used as a verbal tic) and false starts.
- FILLER RESTRAINT: English tolerates far less filler than spoken Mandarin. Drop "so", "well", "you know", "then" wherever they carry no meaning. Trimming filler must never cost content.
- TAG QUESTIONS (是吧 / 对吧 / 对不对 / 是不是 at the end of a clause) are the pastor's verbal tic inviting agreement, and a Mandarin preacher can say one every few sentences. Render one as an English tag only when it is a genuine appeal to the congregation — roughly one occurrence in three; check the previous segments and OMIT it if you used a tag recently. When you do render it, vary it ("Right?", "Isn't it?", "Don't you think?", "You see?") rather than writing "right?" every time. Observed: 27 tags in one sermon came out as 28 "right?"s.
- EMPHATIC REPETITION: when the pastor repeats a phrase for emphasis, keep the emphasis but not the flat echo — render it at most twice, escalating rather than duplicating.
- If the segment is empty, meaningless, or pure filler, return an empty response.`;

export const SYSTEM_PROMPT_EN_KO = `You are a professional simultaneous interpreter translating a LIVE English church sermon into Korean, one spoken segment at a time, as the pastor speaks.

You are given the PREVIOUS translated segments (for context only) and ONE new English segment. Translate ONLY the new segment.

Return ONLY the Korean translation of the new segment, as plain text. No JSON, no quotes around it, no preamble, no labels. If the segment cannot be translated faithfully, return an empty response.

IMPORTANT: The English text comes from automatic speech recognition of a live sermon. It MAY contain mistakes — misheard words, garbled names, wrong word boundaries, or nonsense tokens. Translate conservatively around errors; never "repair" them by inventing content.

ABSOLUTE RULES:
- Output ONLY the Korean translation. Never add notes, explanations, apologies, or descriptions — in ANY language. NEVER write about "the segment", "the input", or that something is incomplete, and never Korean equivalents like "이 문장은 불완전합니다" or "번역할 수 없습니다".
- Be faithful. Translate ONLY what the pastor actually said. Do NOT add ideas, do NOT invent details, and do NOT guess or finish an unfinished thought. English puts the verb early and Korean puts it last, so a segment cut mid-sentence may have no natural Korean sentence ending — even then, do NOT invent the missing verb or complete the thought. Render the fragment as far as the words go, as naturally as Korean allows (a connective ending like -고/-는데 or a noun phrase is fine mid-thought), and STOP — the next segment will continue it.
- Never introduce a specific name, place, number, job, or fact that is not clearly present in the English. Do NOT invent proper nouns. If a word looks like a garbled name or is unintelligible, translate around it or omit it — do NOT turn it into a real-sounding name.
- If a whole segment is too garbled or meaningless to translate faithfully, return an empty response rather than guessing.
- Do NOT use em dashes (—), en dashes (–), or a trailing dash. Do NOT use "..." for suspense. End on the last real word with normal punctuation or nothing.
- It must read as a smooth continuation of the previous segments. Do NOT repeat anything already translated.
- REGISTER (most important): preach in the formal-polite 하십시오체 used from Korean pulpits, consistently: statements end in -습니다/-ㅂ니다, questions in -습니까, exhortations as -하십시오 or -하시기 바랍니다. NEVER use casual 반말 (-한다, -해, -야) and never drift into plain 해요체 as the default sentence ending. Exception: inside quoted dialogue, use the register the quoted speaker would naturally use; the pastor's own voice returns to 하십시오체 immediately after the quote.
- HONORIFICS: God, Jesus, the Lord, and the Holy Spirit take honorific grammar EVERY time: 하나님께서/예수님께서/주님께서/성령님께서 as subjects (never 하나님이/예수님이 in the pastor's own voice), 하나님께 for "to God", and honorific verb forms (말씀하십니다, 일하십니다, 주십니다, 계십니다). Always 하나님, 예수님, 주님, 성령님 — never bare 예수 or 하나님 without 님 where 님 is standard. Name God and Jesus directly (주님, 하나님, 예수님) rather than the distant pronoun 그분 — 그분 reads as clinical from the pulpit ("주님의 은혜가", not "그분의 은혜가"). Address the congregation as 여러분, but do NOT repeat 여러분 twice in one sentence — drop the redundant occurrence the way natural Korean drops pronouns ("여러분이 상상할 수 없을 만큼 사랑하십니다", not "여러분이 상상할 수 있는 것보다 더 여러분을..."). The pastor never uses honorifics about himself; his own actions take plain humble forms.
- VOCABULARY: use the standard Korean church vocabulary the congregation already knows: grace = 은혜, salvation = 구원, faith = 믿음, repentance = 회개, the Holy Spirit = 성령님, worship = 예배, the gospel = 복음, the Word = 말씀, prayer = 기도, blessing = 복/축복, the cross = 십자가, the kingdom of God = 하나님 나라, church = 교회. NEVER transliterate an English word that has a standard Korean equivalent (은혜, never 그레이스) and never invent neologisms. Bible names use their standard Korean Bible forms (John = 요한, Peter = 베드로, Paul = 바울, Abraham = 아브라함, Moses = 모세); transliterate only proper names with no standard Korean form.
- TERMINOLOGY LOCK-IN: once the previous segments establish a Korean rendering for a recurring term, name, or key phrase (e.g. 초대 교인들 for "the early Christians", a person's name, the sermon's theme phrase), REUSE that exact rendering every time the term recurs — never alternate between synonyms (초대 교인들 one segment, 초기 그리스도인들 the next) mid-sermon. Check the previous segments before choosing.
- BIBLE REFERENCES: always render book names in Korean: John 3:16 → 요한복음 3장 16절; First Corinthians 13 → 고린도전서 13장; Psalm 23 → 시편 23편. Use the standard Korean book names (창세기, 시편, 마태복음, 요한계시록 ...), digits for the numbers, and 장/절 (시편 uses 편). When announcing a passage to turn to, attach the object particle: "요한복음 3장 16절을 함께 펴시기 바랍니다", never "요한복음 3장 16절 함께 펴시기 바랍니다".
- SCRIPTURE: when a segment is clearly quoting or reading the Bible, do NOT freely re-translate it. Reproduce the passage in the standard Korean of the 개역개정 translation as you recall it, kept consistent across the whole sermon. Render ONLY the portion actually being quoted — never add surrounding verses or complete a verse the pastor hasn't reached. Translate the pastor's own commentary (everything that is not the quote) normally.
- Silently drop English filler (um, uh, you know, like, I mean, sort of) and false starts.
- REDUNDANT MARKERS: spoken English doubles connective markers ("so, so anyway", "now, now for example"). Within one segment, collapse redundant discourse markers into ONE natural Korean connective (그래서, 자, 예를 들어) — but NEVER collapse repetition of substantive phrases: when the pastor repeats a full clause for emphasis, keep the repetition. That is rhetoric, not redundancy.
- Preacher tics inviting agreement ("Amen?", "Right?", "Come on now") render briefly and vary the phrasing across segments — "아멘?", "그렇습니까?", "그렇지 않습니까?", "믿으시기 바랍니다" — never expand them into longer sentences.
- If the segment ENDS on an abandoned false start — a bare subject, article, or connective the pastor drops before finishing ("And so the, the") — OMIT that dangling tail; do NOT emit a meaningless fragment. (This is different from a genuine mid-sentence cut carrying real content — keep those and stop on the last real word.)
- NATURALNESS (anti-translationese): render the MEANING as a Korean pastor would naturally say it aloud — NEVER a literal clause-by-clause mapping of the English structure. Restructure into natural Korean word order (verb last), render idioms and rhetorical questions by their natural Korean equivalents, and prefer phrasing a Korean pulpit would actually use — even when that means splitting or reshaping the English sentence. Example: "Would you stand with me as we read God's Word?" → "하나님의 말씀을 함께 읽겠습니다. 다 같이 자리에서 일어나시겠습니까?" (natural), NOT "하나님의 말씀을 읽기 위해 자리에서 일어나시겠습니까?" (stiff purpose-clause mapping). Faithfulness to the meaning still comes first — reshape the wording, never the message.
- ENDING & PHRASING VARIETY (HARD RULE): stay strictly in 하십시오체, but monotone endings sound machine-made — real preaching rotates its formal endings by rhetorical role. BEFORE finalizing, look at how the previous segments in the context END. If the last two translated sentences both ended in the plain "-니다" cadence (합니다/입니다/십니다...), this sentence MUST end differently — pick whichever is natural for its role: ~는 것입니다 (emphasis), ~기 때문입니다 (reason), ~게 됩니다 (result), ~지 않습니까? (rhetorical), ~십시오 / ~시기 바랍니다 (exhortation), or reshape into a question or emphatic nominalization. Within one segment, consecutive sentences should not share the identical ending either. EXCEPTION: scripture quotes keep their canonical wording, and deliberate parallel repetition in the English (anaphora, "He was… He was…") is rhetoric — mirror it exactly; never vary away intentional parallelism.
- LIVE-INTERPRETER COMPACTNESS: a live interpreter compresses. Render the FULL meaning in the fewest natural words — never pad with empty frames ("~라고 할 수 있습니다", "~것이라고 생각됩니다"), never add amplifiers the English doesn't have, and never expand one English clause into two Korean sentences unless Korean grammar requires it. When two renderings are equally faithful and natural, always speak the shorter one; the audio must keep pace with the preacher.
- If the segment is empty, meaningless, or pure filler, return an empty response.`;

/** Strip artifacts that make TTS sound wrong, as a safety net behind the prompt. */
export function sanitizeForSpeech(text: string): string {
  let t = text;
  // Drop a dangling dash / ellipsis at the very end FIRST (before dash→comma,
  // or "faith and—" becomes "faith and," and slips past the rules below).
  t = t.replace(/[\s,]*[-–—]+\s*$/g, '');
  t = t.replace(/\s*\.{2,}\s*$/g, '');
  // Turn remaining em/en dashes into natural comma pauses.
  t = t.replace(/\s*[—–]\s*/g, ', ');
  // Peel trailing stranded tokens to a fixed point: removing a dangling subject
  // ("...and we" → "...and") can expose a stranded conjunction, so repeat until
  // nothing more strips.
  let prev: string;
  do {
    prev = t;
    // Remove a lone conjunction/article stranded at the end (e.g. "...faith and").
    t = t.replace(/[\s,]+(and|but|or|so|nor|yet|the|a|an)[\s,]*$/i, '');
    // Remove a stranded subject/false-start at the very end. The pastor abandons a
    // thought ("...Right? That, I") and the model renders the dangling subject
    // literally; a subjectless fragment read aloud is worse than a tiny omission.
    // Kept deliberately narrow: a demonstrative+comma+pronoun tail, or a bare
    // trailing "I"/"we" — real English sentences essentially never end on those.
    t = t.replace(/[\s,]+(?:that|this)\s*,\s*(?:I|we|you)\s*$/i, '');
    t = t.replace(/[\s,]+(?:I|we)\s*$/i, '');
    // Never speak a half-finished scripture citation. Observed live: "Let's
    // read it together in one voice, 2 Peter chapter 1, verse" — the chunk was
    // cut before the pastor said the number. A reference that names no verse
    // is worse than no reference at all, and citations are the highest-stakes
    // text here, so drop the dangling clause back to the last clean boundary.
    t = t.replace(/[\s,]*\b(?:chapter|verses?)\s*\d*\s*[,:]?\s*(?:through|to|and)?\s*$/i, '');
    // That can strip back to a bare book name ("...in one voice, 2 Peter") —
    // a lone book name mid-sentence is also a dangling citation.
    t = t.replace(/[\s,]+(?:\d\s+)?[A-Z][a-z]+\s*$/, (m) =>
      /\b(?:Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|Samuel|Kings|Chronicles|Ezra|Nehemiah|Esther|Job|Psalms?|Proverbs|Ecclesiastes|Isaiah|Jeremiah|Lamentations|Ezekiel|Daniel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|Corinthians|Galatians|Ephesians|Philippians|Colossians|Thessalonians|Timothy|Titus|Philemon|Hebrews|James|Peter|Jude|Revelation)\b/.test(m)
        ? ''
        : m,
    );
  } while (t !== prev);
  // A segment that ends on a comma is usually FAITHFUL — the Korean genuinely
  // stopped mid-sentence, and the prompt correctly says to stop where the words
  // stop. But a trailing comma is rendered by TTS as unfinished intonation, so
  // the listener hears a sentence that never lands. Close it with a period
  // instead: same words, nothing invented, only the final punctuation changes,
  // and the next segment continues as its own sentence. Only do this when a
  // real clause precedes it — a bare fragment is handled by the
  // dangling-modifier rule, which is a different problem.
  if (/,\s*$/.test(t)) {
    const body = t.replace(/,\s*$/, '').trim();
    // Four words is enough to be a clause worth closing; anything shorter is a
    // shard and the comma is simply dropped.
    t = body.split(/\s+/).length >= 4 ? `${body}.` : body;
  }
  // Tidy doubled punctuation/spacing the above may create.
  t = t.replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1');
  return t.trim();
}

/**
 * Detect the model describing the input instead of translating it.
 *
 * Translator-voice tells ONLY. Pastors legitimately say "the passage", "the
 * text", "this word means…" (word studies: "in the original Greek, this
 * means…") and quote people saying "I can't …" — so a noun like passage/text
 * alone, or a bare "I can't", must NOT trigger. Each branch requires the
 * surrounding translator-analysis construction.
 */
export function looksLikeMetaCommentary(text: string): boolean {
  return (
    // "the segment/input" are analysis vocabulary, never sermon vocabulary.
    /\bthe (segment|input)\b/i.test(text) ||
    // "The text/passage/sentence is incomplete / appears cut off / …"
    /\b(the|this) (text|passage|sentence|verse|phrase) (is|appears|seems|looks|ends|was) (to be )?(incomplete|cut off|truncated|a fragment|unfinished|mid-?sentence|mid-?phrase)\b/i.test(text) ||
    /\brequires? the continuation\b/i.test(text) ||
    /\bincomplete mid-?phrase\b/i.test(text) ||
    /\bas an interpreter\b/i.test(text) ||
    // Refusals: "I cannot/can't/am unable (to) translate/render/…"
    /\bI(\s+am|'m)?\s*(cannot|can't|unable)\s+(to\s+)?(translate|render|provide|complete|continue|determine)\b/i.test(text) ||
    /\bthis (appears|seems) (to be )?incomplete\b/i.test(text) ||
    // Korean translator-voice tells (en-ko output). Hangul never appears in
    // English output, so these cannot affect the ko-en direction.
    /번역(?:을|이)?\s*(?:할\s*수\s*없|불가능|제공할\s*수\s*없)/.test(text) ||
    /(?:문장|세그먼트|입력|본문)[이가은는]?\s*(?:불완전|미완성|잘려|끊겨)/.test(text) ||
    /통역사로서/.test(text)
  );
}

/** Strip code fences and extract the first JSON object from a model response. */
export function extractJsonObject(raw: string): string {
  let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];
  return cleaned;
}

/**
 * Last-resort recovery when the model's JSON is unparseable — typically an
 * unescaped quote inside the translation (quoted speech in the sermon) or a
 * truncated response. Dropping the sentence is the worst outcome for a live
 * congregation, and each parse-retry cycle costs ~10s of dead air, so pull
 * the translation value out with string surgery instead: take everything
 * after `"translation": "` and trim the trailing `"}` if it survived.
 */
export function salvageTranslation(raw: string): string | null {
  const m = raw.match(/"translation"\s*:\s*"([\s\S]*)$/);
  if (!m) return null;
  let s = m[1];
  const closing = s.match(/"\s*\}?\s*$/);
  if (closing) s = s.slice(0, closing.index);
  s = s.replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\\\/g, '\\');
  const out = s.trim();
  return out.length > 0 ? out : null;
}

export class ClaudeTranslator {
  private client: Anthropic;
  private model: string;
  private readonly direction: Direction;
  private readonly systemPrompt: string;
  /** Source-language label for prompt text ("Korean" for ko-en). */
  private readonly srcLabel: string;
  /** Target-language label for prompt text ("English" for ko-en). */
  private readonly tgtLabel: string;
  private recentTranslations: { source: string; target: string; seq?: number }[] = [];
  /**
   * Terms pinned for the whole session, kept separately from the rolling
   * context window. maxContext is 8 segments — roughly two minutes — so a song
   * title first rendered at segment 17 was long gone by segment 199, where it
   * came out as "The Scent of Memory" instead of "The Fragrance of Memory".
   * Quoted titles and proper nouns are pinned the first time they are rendered
   * and injected into every later prompt.
   */
  private glossary = new Map<string, string>();
  /** Running count of Mandarin tag questions, for thinTagQuestionsZh. */
  private tagState = { count: 0 };
  private static readonly MAX_GLOSSARY = 24;
  // 8 pairs. A measured A/B put 4 vs 8 at ~80ms of time-to-first-token, inside
  // the noise floor — input volume is NOT the lever it looked like, and the
  // earlier cut to 4 bought nothing. Korean is pro-drop and omits mandatory
  // arguments, so with too little context the translator has to guess the
  // subject and oscillates between "he/we/you/God" across segments.
  private readonly maxContext = 8;

  /**
   * Terms added during the broadcast, or scoped to this one service. Read per
   * call and injected into the USER message, NOT the cached system prompt —
   * see the note in the constructor.
   */
  private readonly getLiveTerms: (() => GlossaryTerm[]) | undefined;
  private readonly targetLang: LangCode;

  constructor(
    apiKey: string,
    model = process.env.TRANSLATION_MODEL || 'claude-sonnet-5',
    direction: Direction = 'ko-en',
    /** Church slug (the room). Selects that church's glossary; see below. */
    roomId?: string,
    opts: {
      /** Church-scope terms, already loaded. Omit to fall back to the env vars. */
      churchTerms?: GlossaryTerm[];
      /** Called per translation for terms that may change mid-broadcast. */
      getLiveTerms?: () => GlossaryTerm[];
    } = {},
  ) {
    // A hung request is worse here than a failed one: emission is ordered by
    // seq, so one stalled call blocks every sentence behind it. A run saw a
    // single call hang for 115s, which delayed the next sentence by 20s and
    // would have been two minutes of silence in a live service. Bound it, and
    // let the SDK retry transport failures rather than dropping the sentence.
    // maxRetries 0 deliberately: translate() already has its own retry loop
    // with the JSON-salvage path, and SDK retries would MULTIPLY with it
    // (2 x 3 x 20s = two minutes of head-of-line blocking, the very thing this
    // bounds). One 15s timeout, one in-loop retry, ~30s absolute worst case
    // against a 1.4s median.
    this.client = new Anthropic({ apiKey, timeout: 15_000, maxRetries: 0 });
    this.model = model;
    this.direction = direction;
    const dirCfg = getDirectionConfig(direction);
    this.systemPrompt = { 'ko-en': SYSTEM_PROMPT_KO_EN, 'en-ko': SYSTEM_PROMPT_EN_KO, 'zh-en': SYSTEM_PROMPT_ZH_EN }[
      dirCfg.translator
    ];
    // Per-church terms: member names, ministry names, the church's own name.
    // These vary by deployment and must not require a code change, so they come
    // from CHURCH_GLOSSARY as "한국어=English" pairs, comma-separated. Appended
    // to the SYSTEM prompt so they ride the prompt cache rather than costing
    // uncached tokens on every segment.
    //
    // This is the CHURCH tier, and it must stay byte-identical for the whole
    // broadcast: the system prompt is sent with cache_control ephemeral, and
    // any edit to it rewrites the cached prefix. That cache miss is paid as
    // time-to-first-token, which a listener hears as a gap in the sermon.
    // Terms added mid-service therefore go to the LIVE tier below instead,
    // never here — they are folded into this block at the next broadcast.
    this.targetLang = dirCfg.targetLang;
    const extra = opts.churchTerms
      ? renderGlossaryLines(opts.churchTerms, this.targetLang)
      : churchGlossaryFromEnv(process.env, roomId);
    if (extra) this.systemPrompt += `\n\nCHURCH-SPECIFIC NAMES (use these exact renderings every time):\n${extra}`;
    this.getLiveTerms = opts.getLiveTerms;
    this.srcLabel = dirCfg.sourceLabel;
    this.tgtLabel = dirCfg.targetLabel;
  }

  async translate(sourceText: string, reference?: ScriptureRef | null, retries = 1, seq?: number): Promise<TranslationResult> {
    // Mandarin tag questions are thinned in code; the prompt alone did not.
    if (this.direction === 'zh-en') sourceText = thinTagQuestionsZh(sourceText, this.tagState);
    // Build context from recent translations.
    let contextBlock = '';
    if (this.recentTranslations.length > 0) {
      const lines = this.recentTranslations
        .map((t) => `${this.srcLabel}: ${t.source}\n${this.tgtLabel}: ${t.target}`)
        .join('\n\n');
      contextBlock = `Previous segments already translated (context only — do NOT repeat, do NOT re-translate):\n\n${lines}\n\n---\n\n`;
    }
    if (this.glossary.size > 0) {
      const pinned = [...this.glossary.entries()].map(([k, v]) => `${k} → ${v}`).join('\n');
      contextBlock =
        `Terms already established EARLIER IN THIS SERVICE. Reuse these exact renderings ` +
        `every time they recur, however long ago they were first said:\n${pinned}\n\n---\n\n` +
        contextBlock;
    }

    // LIVE tier: service-scope terms, plus anything an operator added while the
    // broadcast is running. It rides the user message precisely because that is
    // NOT cached — a term typed at the desk takes effect on the very next
    // sentence without invalidating the system prompt everything else depends
    // on. Filtered to what the chunk mentions once the list grows past the
    // point where sending all of it is cheaper than checking.
    const live = this.getLiveTerms?.() ?? [];
    if (live.length > 0) {
      const lines = renderGlossaryLines(liveTermsForChunk(live, sourceText), this.targetLang);
      if (lines) {
        contextBlock =
          `TERMS FOR THIS SERVICE (highest priority — these override any other ` +
          `rendering, including the ones in your instructions):\n${lines}\n\n---\n\n` +
          contextBlock;
      }
    }

    // Scripture anchoring, strongest available form first:
    //  1. book+chapter+verse detected AND found in the bundled Bible → inject
    //     the canonical verse text itself (real lookup, no model memory).
    //  2. reference known but no verse text available → anchor by name only.
    //  3. no reference → nothing.
    let refBlock = '';
    const zhReading =
      this.direction === 'zh-en' && reference?.book && reference.chapter !== undefined
        ? matchSpokenVersesZh(sourceText, reference.book, reference.chapter)
        : [];
    const refName = formatReference(reference ?? null);
    const window =
      reference?.book && reference.chapter !== undefined && reference.verse !== undefined
        ? getVerseWindow(reference.book, reference.chapter, reference.verse)
        : [];
    if (this.direction === 'en-ko') {
      // Output is Korean: anchor quotes to REAL Korean scripture, strongest
      // available form first — mirror of the ko-en NIV/BSB approach:
      //  1. Confident reference (book+chapter+verse, the only case a window
      //     exists) AND found in the bundled Korean Bible → inject the
      //     canonical Korean verse text itself (real retrieval, no recall).
      //  2. Reference known but no Korean text available → anchor by name,
      //     falling back to consistent 개역개정 recall (English text as
      //     identification when the BSB has it).
      //  3. No/low-confidence reference → nothing is ever injected.
      const krName = formatReferenceKorean(reference ?? null);
      const koWindow =
        reference?.book && reference.chapter !== undefined && reference.verse !== undefined
          ? getVerseWindowKo(reference.book, reference.chapter, reference.verse)
          : [];
      if (koWindow.length > 0) {
        const verses = koWindow.map((w) => `${w.ref} — "${w.text}"`).join('\n');
        refBlock =
          `Canonical Korean text of the passage being read (개역한글; this supplied wording OVERRIDES any other rendering, including 개역개정 recall):\n${verses}\n` +
          `If this segment quotes any portion of the passage, use this EXACT supplied Korean wording for that portion${krName ? ` (cited as ${krName})` : ''} — but render ONLY the words the pastor actually spoke; never add parts of a verse he hasn't reached. Translate his own commentary normally.\n\n`;
      } else if (window.length > 0) {
        const verses = window.map((w) => `${w.ref} — "${w.text}"`).join('\n');
        refBlock =
          `Canonical English text of the passage being read (so you can identify exactly which verse is being quoted):\n${verses}\n` +
          `If this segment quotes any portion of this passage, render that portion in its standard 개역개정 Korean wording${krName ? ` (cited as ${krName})` : ''}, kept consistent across the sermon — and render ONLY the words the pastor actually spoke; never add parts of a verse he hasn't reached. Translate his own commentary normally.\n\n`;
      } else if (refName) {
        refBlock = `The pastor is currently reading from ${refName}${krName ? ` (${krName})` : ''}. If this segment quotes that passage, reproduce the standard 개역개정 Korean wording of the relevant verse(s); otherwise translate the commentary normally.\n\n`;
      }
    } else if (zhReading.length > 0) {
      // Mandarin: the verses actually being read, recognised from the spoken
      // words rather than from a verse number he may never say. The Chinese
      // text lets the model see what he skipped or has not reached; the
      // English is the wording to use for what he DID say.
      const lines = zhReading
        .map((m) => `${reference!.book} ${reference!.chapter}:${m.verse}\n  Chinese (和合本): ${m.text}\n  English (BSB): ${getVerse(reference!.book!, reference!.chapter!, m.verse) ?? ''}`)
        .join('\n');
      refBlock =
        `This segment reads from the Bible. The verse(s) it comes from:\n${lines}\n` +
        `Compare the pastor's words with the Chinese text: translate ONLY the parts he actually spoke, using the English wording above for those parts. ` +
        `Leave out whatever he skipped or has not reached yet, even if it is in the same verse. Where his words differ because the recogniser misheard (the Chinese text shows the real words), follow the Chinese text. ` +
        `These verse numbers are for identification only — say a number only if he says it.\n\n`;
    } else if (window.length > 0) {
      // Label the announced verse and quarantine its neighbours. Supplying a
      // flat list of three numbered verses let the model cite whichever it
      // liked: live, the pastor announced 2 Peter 1:9, the output read verse
      // 9's text but announced "verse 10".
      const [announced, ...rest] = window;
      const contextVerses = rest.map((w) => `${w.ref} — "${w.text}"`).join('\n');
      refBlock =
        `The pastor announced ${announced.ref}. He SPOKE that verse number, so it is authoritative.\n` +
        `Canonical English text of the announced verse (this wording OVERRIDES any other rendering, including NIV recall):\n${announced.ref} — "${announced.text}"\n` +
        (contextVerses
          ? `The verses below are supplied ONLY in case the reading runs past the announced verse. ` +
            `The pastor has NOT said these numbers — never speak them unless he does:\n${contextVerses}\n`
          : '') +
        `If this segment quotes any portion of the passage, use the EXACT supplied wording for that portion — but render ONLY the words the pastor actually spoke; never add parts of a verse he hasn't reached. Translate his own commentary normally.\n\n`;
    } else if (refName) {
      refBlock = `The pastor is currently reading from ${refName}. If this segment quotes that passage, use the standard English wording for the words he actually spoke (never the parts of a verse he skipped or has not reached); otherwise translate the commentary normally.\n\n`;
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: this.model,
          // 1024, not 512: a long sentence that hits the cap truncates the
          // JSON mid-string. salvageTranslation recovers partial text, but not
          // hitting the cap at all is better.
          max_tokens: 1024,
          // Cache the (large, static) system prompt: every sentence of the
          // sermon reuses it, so cache hits cut time-to-first-token — this is
          // per-sentence latency the listener hears as part of each gap.
          system: [{ type: 'text', text: this.systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [
            {
              role: 'user',
              content: `${contextBlock}${refBlock}Translate ONLY this new ${this.srcLabel} segment:\n\n${sourceText}`,
            },
          ],
        });

        // Scan ALL blocks for text — Sonnet can emit a leading non-text block,
        // and assuming content[0] is text intermittently dropped whole segments.
        const raw = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();

        if (!raw) {
          // An EMPTY response is retryable, not fatal. Three sentences were
          // lost in a clean run to an empty completion that vanished silently.
          throw new Error(
            `empty response (stop_reason=${response.stop_reason ?? 'unknown'}, blocks=${response.content.length})`,
          );
        }

        // Plain text, not JSON. The JSON wrapper cost ~8 output tokens of
        // scaffolding before the first real word on every single segment, and
        // it was a standing failure source: unescaped quotes in sermon dialogue
        // broke the parse and dropped whole sentences, which is why
        // salvageTranslation had to exist. The model is asked for bare text, so
        // only stray wrapping quotes need trimming.
        let translated = raw.trim();
        // Only unwrap quotes that enclose the WHOLE translation. Stripping each
        // end independently broke real quoted speech: 'But Jesus said, "Love one
        // another."' lost its closing quote and went out unbalanced — and this
        // pastor voices quoted speech constantly.
        const wrapped = /^["'`\u201c\u2018]([\s\S]*)["'`\u201d\u2019]$/.exec(translated);
        if (wrapped && !/["\u201c\u201d]/.test(wrapped[1])) translated = wrapped[1].trim();

        // Guard: if the model described the input instead of translating, drop it.
        if (translated && looksLikeMetaCommentary(translated)) {
          console.warn('[Translation] Dropped meta-commentary output:', translated.slice(0, 80));
          translated = '';
        }

        translated = sanitizeForSpeech(translated);
        // A Chinese character in English output is read aloud IN CHINESE:
        // eleven_flash_v2_5 is multilingual and switches language per token.
        // The prompt forbids it; this guarantees it.
        if (this.targetLang === 'en' && /[\u4e00-\u9fff]/.test(translated)) {
          console.warn('[Translation] Stripped Chinese characters from English output:', translated.slice(0, 80));
          translated = translated.replace(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
        }

        // Only remember real translations, so context stays clean.
        if (translated) {
          // Insert in SPOKEN order, not completion order. With two
          // translations in flight, seq N+1 can return before seq N, which
          // used to leave the context array reversed and the discourse
          // context subtly wrong for every later segment.
          this.pinTerms(sourceText, translated);
          this.recentTranslations.push({ source: sourceText, target: translated, seq });
          this.recentTranslations.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
          if (this.recentTranslations.length > this.maxContext) {
            this.recentTranslations.shift();
          }
        }

        return {
          direct_translation: translated, // kept for message compat; UI shows sermon
          sermon_translation: translated || '[Translation error]',
          notes_on_ambiguity: '',
        };
      } catch (err) {
        console.error(`[Translation] Attempt ${attempt + 1} failed:`, err);
        if (attempt === retries) {
          return {
            direct_translation: '[Translation error]',
            sermon_translation: '[Translation error]',
            notes_on_ambiguity: String(err),
          };
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    return {
      direct_translation: '[Translation error]',
      sermon_translation: '[Translation error]',
      notes_on_ambiguity: '',
    };
  }

  /** Clear context (e.g. on new broadcast session) */
  /**
   * Pin quoted titles and multi-word proper nouns so they stay consistent for
   * the whole service. Only quoted strings and Title Case runs are taken —
   * ordinary prose must not accumulate here.
   */
  private pinTerms(source: string, target: string): void {
    // Key on the KOREAN phrase, not on quotation marks. Deepgram emits no
    // quote marks for Korean — 기억의 향기라는 노래 has none — so the previous
    // quote-pairing version never pinned anything and the song title kept
    // flipping between "Fragrance of Memory" and "Scent of Memory" mid-service.
    //
    // Korean names a title with the ~라는/~이라는 particle ("the song CALLED
    // X"), which is a reliable hook for exactly the phrases worth pinning.
    const titles = [
      ...[...source.matchAll(/([가-힣][가-힣\s]{1,18}?)(?:이)?라는/g)].map((m) => m[1].trim()),
      // Mandarin names a title with book-title brackets 《…》, or as
      // 叫(做)…的 + 歌/诗/书/电影 ("a song CALLED X").
      ...[...source.matchAll(/《([^《》]{1,20})》/g)].map((m) => m[1].trim()),
      ...[...source.matchAll(/叫做?([\u4e00-\u9fff]{2,12}?)的(?:歌|诗|书|电影|诗歌|赞美诗)/g)].map((m) => m[1].trim()),
    ];
    if (titles.length === 0) return;
    // The English rendering of a title is normally quoted or Title Case.
    const quoted = [...target.matchAll(/['‘’"“”]([^'‘’"“”]{2,40})['‘’"“”]/g)].map((m) => m[1].trim());
    const titleCase = target.match(/\b(?:The\s)?(?:[A-Z][a-z]+\s){1,4}of\s[A-Z][a-z]+\b/);
    const rendering = (quoted[0] ?? titleCase?.[0])?.replace(/[.,!?;:]+$/, '').trim();
    if (!rendering) return;
    for (const k of titles) {
      if (k.length < 2 || this.glossary.has(k)) continue;
      this.glossary.set(k, rendering);
      if (this.glossary.size > ClaudeTranslator.MAX_GLOSSARY) {
        const oldest = this.glossary.keys().next().value;
        if (oldest !== undefined) this.glossary.delete(oldest);
      }
    }
  }


  resetContext(): void {
    this.recentTranslations = [];
    this.glossary.clear();
  }

  /**
   * Pre-seed conversational context (used by evals/tests to mimic mid-sermon
   * state). Field names are historical: `korean` is the SOURCE segment and
   * `english` the TARGET translation, whatever the direction.
   */
  seedContext(pairs: { korean: string; english: string }[]): void {
    this.recentTranslations = pairs
      .slice(-this.maxContext)
      .map((p) => ({ source: p.korean, target: p.english }));
  }
}

/**
 * Per-church proper nouns, from `CHURCH_GLOSSARY` as comma-separated
 * `한국어=English` pairs — e.g. `한마음=Hanmaum,권희=Kwon-hee`.
 *
 * Member names during a welcome are socially high-stakes: a garbled name is
 * heard by exactly the person being welcomed. Recognition also needs biasing,
 * which is what DEEPGRAM_KEYTERMS does — the two work together, one so the
 * name is HEARD and one so it is SPELLED the same way every time.
 */
/** Re-exported: the env format now has one implementation, in glossary/env. */
export { glossaryEnvKey } from './glossary/env';


/**
 * Proper nouns pinned for one church, as prompt lines.
 *
 * One deployment serves every church — a Session per room, but a single
 * process and therefore a single environment. A flat CHURCH_GLOSSARY would
 * put every congregation's names into every other congregation's prompt:
 * harmless for a name that never comes up, actively wrong the moment two
 * churches disagree (one wants 목자 as "shepherd", another as "Mokja"), and
 * needless prompt weight for all of them.
 *
 * So CHURCH_GLOSSARY holds only what is TRUE EVERYWHERE, and each church adds
 * its own CHURCH_GLOSSARY_<SLUG> on top, which wins on conflict. Member names
 * belong in the per-church one — a garbled name during a welcome is heard by
 * exactly the person being welcomed, and no other church should be carrying it.
 */
export function churchGlossaryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  roomId?: string,
): string {
  return [...envGlossaryPairs(env, roomId)].map(([ko, en]) => `${ko} = "${en}"`).join('\n');
}
