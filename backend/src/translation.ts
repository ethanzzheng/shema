/**
 * Claude-based Korean → English translation for a live sermon.
 *
 * Translates one spoken segment at a time, given the recent segments as
 * context so the output reads as a continuous interpretation. The prompt is
 * deliberately strict: translate ONLY what was said, never invent or "complete"
 * an unfinished thought, and never emit notes/dashes — those were the source of
 * the nonsense, dangling "—", and meta-commentary getting read aloud.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ScriptureRef, formatReference } from './scripture';
import { getVerseWindow } from './bible';

export interface TranslationResult {
  direct_translation: string;
  sermon_translation: string;
  notes_on_ambiguity: string;
}

const SYSTEM_PROMPT = `You are a professional simultaneous interpreter translating a LIVE Korean church sermon into English, one spoken segment at a time, as the pastor speaks.

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
- Silently drop Korean filler (음, 어, 그, 아) and false starts. If a segment ENDS on an abandoned false start — a bare subject or demonstrative with no predicate that the pastor drops before finishing the thought (e.g. "그 내가", "저 그거") — OMIT that dangling tail; do NOT emit a subjectless fragment like "That, I" or "So we". (This is different from a genuine mid-sentence cut that carries real content the next segment will continue — keep those and stop on the last real word.)
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

/** Detect the model describing the input instead of translating it. */
export function looksLikeMetaCommentary(text: string): boolean {
  return /\b(the (segment|input|text|passage|sentence)\b|requires? the continuation|incomplete mid-?phrase|as an interpreter|I (cannot|can't|am unable|'m unable)|this (appears|seems) (to be )?incomplete)\b/i.test(
    text,
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
  private recentTranslations: { korean: string; english: string }[] = [];
  private readonly maxContext = 8; // keep last 8 segments for discourse continuity

  constructor(apiKey: string, model = process.env.TRANSLATION_MODEL || 'claude-sonnet-5') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async translate(koreanText: string, reference?: ScriptureRef | null, retries = 1): Promise<TranslationResult> {
    // Build context from recent translations.
    let contextBlock = '';
    if (this.recentTranslations.length > 0) {
      const lines = this.recentTranslations
        .map((t) => `Korean: ${t.korean}\nEnglish: ${t.english}`)
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
    if (window.length > 0) {
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
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [
            {
              role: 'user',
              content: `${contextBlock}${refBlock}Translate ONLY this new Korean segment:\n\n${koreanText}`,
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

        let english = parsed.translation.trim();

        // Guard: if the model described the input instead of translating, drop it.
        if (english && looksLikeMetaCommentary(english)) {
          console.warn('[Translation] Dropped meta-commentary output:', english.slice(0, 80));
          english = '';
        }

        english = sanitizeForSpeech(english);

        // Only remember real translations, so context stays clean.
        if (english) {
          this.recentTranslations.push({ korean: koreanText, english });
          if (this.recentTranslations.length > this.maxContext) {
            this.recentTranslations.shift();
          }
        }

        return {
          direct_translation: english, // kept for message compat; UI shows sermon
          sermon_translation: english || '[Translation error]',
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

  /** Pre-seed conversational context (used by evals/tests to mimic mid-sermon state). */
  seedContext(pairs: { korean: string; english: string }[]): void {
    this.recentTranslations = pairs.slice(-this.maxContext);
  }
}
