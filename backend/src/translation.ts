/**
 * Claude-based Korean → English translation.
 * Maintains recent translation history for context continuity.
 */

import Anthropic from '@anthropic-ai/sdk';

export interface TranslationResult {
  direct_translation: string;
  sermon_translation: string;
  notes_on_ambiguity: string;
}

const SYSTEM_PROMPT = `You are a Korean-to-English interpreter for a modern church sermon. You translate live sermon segments in real-time.

Return ONLY valid JSON:
{
  "direct_translation": "Accurate literal translation.",
  "sermon_translation": "Natural modern English paragraph(s).",
  "notes_on_ambiguity": ""
}

Rules for sermon_translation:
- Write in complete sentences. Never leave a sentence unfinished.
- If the Korean input ends mid-thought, complete the sentence naturally based on context.
- Group related sentences into short paragraphs. Use line breaks between distinct thoughts.
- Use modern, everyday English — how a young pastor would actually speak in 2025.
- Avoid archaic words (use "long for" not "yearn", "gift" not "bestow").
- Keep standard Bible terms (grace, salvation, Holy Spirit, faith, redemption).
- Preserve Bible references exactly (e.g. John 3:16).
- Remove Korean filler words (음, 어, 그, 그래서, 아).
- Do NOT add meaning or content not in the source.
- Do NOT repeat anything from previous context. Only translate the NEW segment.
- The output should read as a natural continuation of the previous segments.
- Your response must start with { and end with }. No preamble.`;

export class ClaudeTranslator {
  private client: Anthropic;
  private model: string;
  private recentTranslations: { korean: string; english: string }[] = [];
  private readonly maxContext = 5; // keep last 5 translations for context

  constructor(apiKey: string, model = 'claude-haiku-4-5-20251001') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async translate(
    koreanText: string,
    retries = 1,
  ): Promise<TranslationResult> {
    // Build context from recent translations
    let contextBlock = '';
    if (this.recentTranslations.length > 0) {
      const lines = this.recentTranslations
        .map((t) => `Korean: ${t.korean}\nEnglish: ${t.english}`)
        .join('\n\n');
      contextBlock = `Here are the previous segments already translated (DO NOT repeat these, just use for context):\n\n${lines}\n\n---\n\n`;
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 512,
          system: SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: `${contextBlock}Translate this NEW Korean sermon segment:\n\n${koreanText}`,
            },
            {
              role: 'assistant',
              content: '{',
            },
          ],
        });

        const raw =
          response.content[0].type === 'text'
            ? response.content[0].text.trim()
            : '';

        // Prepend the '{' from the assistant prefill, then strip code fences
        let cleaned = ('{' + raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

        // Extract the first JSON object if there's extra text around it
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          cleaned = jsonMatch[0];
        }

        const parsed: TranslationResult = JSON.parse(cleaned);

        if (
          typeof parsed.direct_translation !== 'string' ||
          typeof parsed.sermon_translation !== 'string'
        ) {
          throw new Error('Unexpected JSON shape from Claude');
        }

        // Store for context in future translations
        this.recentTranslations.push({
          korean: koreanText,
          english: parsed.sermon_translation,
        });
        if (this.recentTranslations.length > this.maxContext) {
          this.recentTranslations.shift();
        }

        return parsed;
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
}
