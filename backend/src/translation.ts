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

import Anthropic from '@anthropic-ai/sdk';
import { ScriptureRef, formatReference } from './scripture';
import { formatReferenceKorean } from './scripture-en';
import { getVerseWindow } from './bible';
import { Direction } from './direction-config';

export interface TranslationResult {
  direct_translation: string;
  sermon_translation: string;
  notes_on_ambiguity: string;
}

export const SYSTEM_PROMPT_KO_EN = `You are a professional simultaneous interpreter translating a LIVE Korean church sermon into English, one spoken segment at a time, as the pastor speaks.

You are given the PREVIOUS translated segments (for context only) and ONE new Korean segment. Translate ONLY the new segment.

Return ONLY valid JSON, nothing else:
{"translation": "the English translation of the new segment"}

IMPORTANT: The Korean text comes from automatic speech recognition of a live sermon. It MAY contain mistakes — misheard words, garbled names, wrong word boundaries, or nonsense tokens. Translate conservatively around errors; never "repair" them by inventing content.

ABSOLUTE RULES:
- Output ONLY the English translation. Never add notes, explanations, apologies, or descriptions. NEVER write about "the segment", "the input", the "continuation", or that something is incomplete.
- Be faithful. Translate ONLY what the pastor actually said. Do NOT add ideas, do NOT invent details, and do NOT guess or finish an unfinished thought. If the segment stops mid-sentence, translate exactly as far as the words go and STOP there — the next segment will continue it.
- Never introduce a specific name, place, number, job, or fact that is not clearly present in the Korean. Do NOT invent proper nouns. If a word looks like a garbled name or is unintelligible, translate around it (e.g. "what was said") or omit it — do NOT turn it into a real-sounding name.
- If a whole segment is too garbled or meaningless to translate faithfully, return {"translation": ""} rather than guessing.
- Do NOT use em dashes (—), en dashes (–), or a trailing dash. Do NOT use "..." for suspense. End on the last real word with a normal period, comma, or nothing.
- It must read as a smooth continuation of the previous segments. Do NOT repeat anything already translated.
- CLARITY (important): Translate the MEANING into natural, clear, everyday American English — the way a native English-speaking pastor would say it to an ordinary US congregation. Do NOT translate word-for-word when that produces awkward, stilted, or confusing English; rephrase so it is easy to understand the first time it's heard. Avoid archaic words (say "long for", not "yearn"). Faithfulness to the meaning still comes first — simplify the wording, never the message.
- Render Korean church idioms by their real meaning, not a literal gloss. Examples: "역사를 이루다 / 역사하다" = "work" or "accomplish (his work)", NOT "make history"; "은혜를 받다" = "be blessed / receive grace"; "말씀" (in context) = "the Word" or "what God says". Don't leave Konglish loanwords literal — use "recruit", not "scout". The listener should never hear a phrase that sounds like translated-ese.
- CHURCH GLOSSARY (use these exact renderings, consistently): 목장 = "Mokjang" (NEVER "cell group", "small group", or "house church" — the congregation knows this word); 목자 = "shepherd" (the person who leads a Mokjang); 목녀 = "shepherdess"; 목장 모임 = "Mokjang meeting"; QT/큐티 = "QT (quiet time)". The STT often garbles these (e.g. 먹자 → 목자) — recognize them from context.
- CHURCH OFFICES (titles the congregation knows — keep them short and consistent, do NOT over-formalize): 목사(님) = "Pastor"; 전도사(님) = "the evangelist" (an associate/assistant minister); 장로(님) = "elder"; 권사(님) = "Kwonsa" (a senior appointed lay office, usually an older woman — use "Kwonsa", NEVER "deaconess", which is a different office); 집사(님) = "deacon" (a woman may be "deaconess"). 권사 and 집사 are DIFFERENT offices — never merge them.
- Keep standard Christian terms (grace, salvation, Holy Spirit, faith, repentance) and Bible references exactly (e.g. John 6:9).
- SCRIPTURE: This pastor quotes the Bible constantly, and the transcription of quoted verses is often badly garbled. When a segment is clearly quoting or reading Scripture, do NOT re-translate the garbled Korean and do NOT paraphrase. If the user message supplies the canonical English text of the passage, use that EXACT wording. Otherwise reproduce the passage in its standard modern English wording (NIV-style) as you recall it, kept consistent across the whole sermon. Render ONLY the portion actually being quoted — never add surrounding verses or complete a verse the pastor hasn't reached. Translate the pastor's own commentary (everything that is not the quote) normally.
- Silently drop Korean filler (음, 어, 그, 아) and false starts.
- REDUNDANT MARKERS: spoken Korean doubles connective markers ("예를 들어서 이제 이제 예를 몇 개 드리겠는데"). Within one segment, collapse such redundant discourse markers into ONE natural rendering — "Let me give you a few examples", never "For example, let me give you a few examples". This applies ONLY to connective/filler markers (for example, so, now, well / 예를 들어, 이제, 그러니까, 자). NEVER collapse repetition of substantive phrases: when the pastor repeats a full clause for emphasis ("...사랑이 있는지, ...사랑이 있는지"), keep the repetition — that is rhetoric, not redundancy.
- UNMARKED QUOTES & INNER THOUGHTS: spoken Korean drops into someone's quoted words or inner deliberation with NO "he said" frame and NO pronoun shift — translated literally this reads as broken point-of-view in English ("he has a friend. My friend is a pastor. Whether it was right for me to go..."). When the story context makes clear the pastor is voicing ANOTHER person's words or thoughts, make the structure explicit with the MINIMAL intervention: either a short frame ("He thought:", "He said,") or pronoun normalization ("whether HE should go") — whichever stays closest to the actual wording. Add no other content. NEVER apply this to the pastor's own first-person testimony ("제 얘기를 드릴게요...") — his own "I" stays "I". GARBLE CORRECTION COMES FIRST: resolve likely STT mishears before any quote/POV reading — never preserve a first-person word that only exists because of a garble (e.g. "제 아들" in a disciples context is garbled "제자들" = "the disciples", NOT "my son").
- REFERENT CONTINUITY: once the previous segments establish who someone is (e.g. "Shepherd Jo Jeong-hwan", "his pastor friend in Boston"), keep that person's name and title consistent and resolve ambiguous references against the established cast — do not re-derive them from the current segment alone. If the STT text conflicts with an established role (목자/목사 are often swapped by STT), trust the established role.
- 그렇죠?/그쵸? is the pastor's verbal tic inviting agreement. Render it briefly and vary the phrasing across segments — "Right?", "You see?", "Isn't that so?", "Don't you agree?" — rather than writing "Right?" every single time (check the previous segments for which you used last). Pick whatever fits the sentence's rhythm; never expand it into a longer sentence. If a segment ENDS on an abandoned false start — a bare subject or demonstrative with no predicate that the pastor drops before finishing the thought (e.g. "그 내가", "저 그거") — OMIT that dangling tail; do NOT emit a subjectless fragment like "That, I" or "So we". (This is different from a genuine mid-sentence cut that carries real content the next segment will continue — keep those and stop on the last real word.)
- If the segment is empty, meaningless, or pure filler, return {"translation": ""}.
- Your entire response must be the JSON object, starting with { and ending with }.`;

export const SYSTEM_PROMPT_EN_KO = `You are a professional simultaneous interpreter translating a LIVE English church sermon into Korean, one spoken segment at a time, as the pastor speaks.

You are given the PREVIOUS translated segments (for context only) and ONE new English segment. Translate ONLY the new segment.

Return ONLY valid JSON, nothing else:
{"translation": "the Korean translation of the new segment"}

IMPORTANT: The English text comes from automatic speech recognition of a live sermon. It MAY contain mistakes — misheard words, garbled names, wrong word boundaries, or nonsense tokens. Translate conservatively around errors; never "repair" them by inventing content.

ABSOLUTE RULES:
- Output ONLY the Korean translation. Never add notes, explanations, apologies, or descriptions — in ANY language. NEVER write about "the segment", "the input", or that something is incomplete, and never Korean equivalents like "이 문장은 불완전합니다" or "번역할 수 없습니다".
- Be faithful. Translate ONLY what the pastor actually said. Do NOT add ideas, do NOT invent details, and do NOT guess or finish an unfinished thought. English puts the verb early and Korean puts it last, so a segment cut mid-sentence may have no natural Korean sentence ending — even then, do NOT invent the missing verb or complete the thought. Render the fragment as far as the words go, as naturally as Korean allows (a connective ending like -고/-는데 or a noun phrase is fine mid-thought), and STOP — the next segment will continue it.
- Never introduce a specific name, place, number, job, or fact that is not clearly present in the English. Do NOT invent proper nouns. If a word looks like a garbled name or is unintelligible, translate around it or omit it — do NOT turn it into a real-sounding name.
- If a whole segment is too garbled or meaningless to translate faithfully, return {"translation": ""} rather than guessing.
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
- If the segment is empty, meaningless, or pure filler, return {"translation": ""}.
- Your entire response must be the JSON object, starting with { and ending with }.`;

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
  } while (t !== prev);
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

export class ClaudeTranslator {
  private client: Anthropic;
  private model: string;
  private readonly direction: Direction;
  private readonly systemPrompt: string;
  /** Source-language label for prompt text ("Korean" for ko-en). */
  private readonly srcLabel: string;
  /** Target-language label for prompt text ("English" for ko-en). */
  private readonly tgtLabel: string;
  private recentTranslations: { source: string; target: string }[] = [];
  private readonly maxContext = 8; // keep last 8 segments for discourse continuity

  constructor(
    apiKey: string,
    model = process.env.TRANSLATION_MODEL || 'claude-sonnet-5',
    direction: Direction = 'ko-en',
  ) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.direction = direction;
    this.systemPrompt = direction === 'en-ko' ? SYSTEM_PROMPT_EN_KO : SYSTEM_PROMPT_KO_EN;
    this.srcLabel = direction === 'en-ko' ? 'English' : 'Korean';
    this.tgtLabel = direction === 'en-ko' ? 'Korean' : 'English';
  }

  async translate(sourceText: string, reference?: ScriptureRef | null, retries = 1): Promise<TranslationResult> {
    // Build context from recent translations.
    let contextBlock = '';
    if (this.recentTranslations.length > 0) {
      const lines = this.recentTranslations
        .map((t) => `${this.srcLabel}: ${t.source}\n${this.tgtLabel}: ${t.target}`)
        .join('\n\n');
      contextBlock = `Previous segments already translated (context only — do NOT repeat, do NOT re-translate):\n\n${lines}\n\n---\n\n`;
    }

    // Scripture anchoring, strongest available form first:
    //  1. book+chapter+verse detected AND found in the bundled Bible → inject
    //     the canonical verse text itself (real lookup, no model memory).
    //  2. reference known but no verse text available → anchor by name only.
    //  3. no reference → nothing.
    let refBlock = '';
    const refName = formatReference(reference ?? null);
    const window =
      reference?.book && reference.chapter !== undefined && reference.verse !== undefined
        ? getVerseWindow(reference.book, reference.chapter, reference.verse)
        : [];
    if (this.direction === 'en-ko') {
      // Output is Korean: anchor quotes to the 개역개정 rendering of the
      // passage. The bundled Bible is English (BSB), so when available it is
      // injected as IDENTIFICATION of exactly which verse is being quoted —
      // the Korean wording itself comes from consistent 개역개정 recall.
      const krName = formatReferenceKorean(reference ?? null);
      if (window.length > 0) {
        const verses = window.map((w) => `${w.ref} — "${w.text}"`).join('\n');
        refBlock =
          `Canonical English text of the passage being read (so you can identify exactly which verse is being quoted):\n${verses}\n` +
          `If this segment quotes any portion of this passage, render that portion in its standard 개역개정 Korean wording${krName ? ` (cited as ${krName})` : ''}, kept consistent across the sermon — and render ONLY the words the pastor actually spoke; never add parts of a verse he hasn't reached. Translate his own commentary normally.\n\n`;
      } else if (refName) {
        refBlock = `The pastor is currently reading from ${refName}${krName ? ` (${krName})` : ''}. If this segment quotes that passage, reproduce the standard 개역개정 Korean wording of the relevant verse(s); otherwise translate the commentary normally.\n\n`;
      }
    } else if (window.length > 0) {
      const verses = window.map((w) => `${w.ref} — "${w.text}"`).join('\n');
      refBlock =
        `Canonical English text of the passage being read (this supplied wording OVERRIDES any other rendering, including NIV recall):\n${verses}\n` +
        `If this segment quotes any portion of the passage, use this EXACT supplied wording for that portion — but render ONLY the words the pastor actually spoke; never add parts of a verse he hasn't reached. Translate his own commentary normally.\n\n`;
    } else if (refName) {
      refBlock = `The pastor is currently reading from ${refName}. If this segment quotes that passage, reproduce the standard English wording of the relevant verse(s); otherwise translate the commentary normally.\n\n`;
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 512,
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

        const parsed = JSON.parse(extractJsonObject(raw)) as { translation?: unknown };
        if (typeof parsed.translation !== 'string') {
          throw new Error('Unexpected JSON shape from Claude');
        }

        let translated = parsed.translation.trim();

        // Guard: if the model described the input instead of translating, drop it.
        if (translated && looksLikeMetaCommentary(translated)) {
          console.warn('[Translation] Dropped meta-commentary output:', translated.slice(0, 80));
          translated = '';
        }

        translated = sanitizeForSpeech(translated);

        // Only remember real translations, so context stays clean.
        if (translated) {
          this.recentTranslations.push({ source: sourceText, target: translated });
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
  resetContext(): void {
    this.recentTranslations = [];
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
