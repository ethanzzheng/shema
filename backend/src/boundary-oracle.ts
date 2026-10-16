/**
 * Is this buffer a complete thought yet? A fast model answers for Chinese.
 *
 * Korean marks the end of every sentence grammatically (-니다, -요), so the
 * Korean chunker knows within a beat when a sentence is done: its median hold
 * is about 1s. Chinese has no such ending, and recognition adds little
 * punctuation (7% of Cantonese finals end on 。？！), so the chunker could only
 * wait for a pause or a timeout. That cost 3-6s of hold per piece and cut many
 * sentences mid-thought.
 *
 * This asks a small model, after each recognition final, whether the buffer
 * ends where a thought ends, and if not, where the last complete thought inside
 * it ends. It runs beside the chunker's timers and never blocks them: a slow,
 * failed or unparseable answer is simply no answer, and the rules decide.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface OracleVerdict {
  /** The whole buffer ends at a complete thought. */
  complete: boolean;
  /** When not complete: length of the prefix that IS a complete thought. */
  headLen?: number;
}

export interface OracleContext {
  /** The end of the previous piece, already sent for translation. */
  previous: string;
  /** Silence after the buffer's last word, when known. */
  pauseMs?: number;
}

export type BoundaryOracle = (buffer: string, ctx: OracleContext) => Promise<OracleVerdict | null>;

export const ORACLE_MODEL = 'claude-haiku-5-5';

export function oraclePrompt(language: string): string {
  return `You split a live ${language} church sermon into pieces for a simultaneous interpreter, who translates each piece into spoken English the moment it is sent. The text is automatic speech recognition: little or no punctuation, and some words misheard.

You get the end of the previous piece (already sent) and the CURRENT BUFFER (not sent yet; the pastor may still be talking). Decide whether the buffer can be sent now.

COMPLETE means the buffer ends where a sentence or self-contained thought ends, so its English would not stop mid-clause. NOT complete: a subordinate clause without its main clause ("because...", "if...", "when..."), a verb still missing its object, a modifier before its noun (ending on 的/嘅), a coverb or conjunction at the end, a list or a comparison in progress, a quotation just introduced ("he said"), a question word the pastor is about to answer.

If NOT complete, find the LAST point inside the buffer where a complete thought ends and everything after it belongs to the next thought. Copy the 4 to 8 characters immediately BEFORE that point exactly as they appear in the buffer.

Reply with ONE line of JSON and nothing else:
{"complete":true}
{"complete":false,"cut_after":"<characters>"}
{"complete":false}`;
}

/** Map the model's reply onto the buffer. Exported for tests. */
export function parseVerdict(raw: string, buffer: string): OracleVerdict | null {
  const m = raw.match(/\{[^{}]*\}/);
  if (!m) return null;
  let obj: { complete?: unknown; cut_after?: unknown };
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (obj.complete === true) return { complete: true };
  if (obj.complete !== false) return null;
  const cut = typeof obj.cut_after === 'string' ? obj.cut_after.trim() : '';
  if (cut.length < 2) return { complete: false };
  // The last occurrence: the model is asked for the LAST complete thought.
  const at = buffer.lastIndexOf(cut);
  if (at < 0) return { complete: false };
  const headLen = at + cut.length;
  // Absorb punctuation that belongs with the head.
  let end = headLen;
  while (end < buffer.length && '，,。！？!?；;、 '.includes(buffer[end])) end++;
  if (end >= buffer.trimEnd().length) return { complete: true };
  return { complete: false, headLen: end };
}

export function createBoundaryOracle(
  apiKey: string,
  language: string,
  opts: { model?: string; timeoutMs?: number } = {},
): BoundaryOracle {
  // No retries: an answer that arrives late is worthless, the rules will have
  // decided by then.
  const client = new Anthropic({ apiKey, timeout: opts.timeoutMs ?? 2500, maxRetries: 0 });
  const system = oraclePrompt(language);
  const model = opts.model ?? process.env.BOUNDARY_ORACLE_MODEL ?? ORACLE_MODEL;
  return async (buffer, ctx) => {
    try {
      const pause = ctx.pauseMs !== undefined ? `\nThe pastor then paused for ${(ctx.pauseMs / 1000).toFixed(1)}s.` : '';
      const res = await client.messages.create({
        model,
        max_tokens: 40,
        temperature: 0,
        system,
        messages: [
          {
            role: 'user',
            content: `END OF PREVIOUS PIECE: ${ctx.previous || '(none)'}\n\nCURRENT BUFFER: ${buffer}${pause}`,
          },
        ],
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return parseVerdict(text, buffer);
    } catch (err) {
      console.warn('[Oracle] no verdict:', (err as Error).message);
      return null;
    }
  };
}
