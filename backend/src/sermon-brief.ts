/**
 * A running brief of the sermon so far, for the translator's long-range memory.
 *
 * The translator sees the last 8 segments, about two minutes. That is too short
 * for what a sermon builds over half an hour: a closing prayer's slip ("let US
 * sit on the throne") is only recognisable as a slip against a point made ten
 * minutes earlier, a title said once at the start is needed again at the end,
 * and a name's spelling must hold for the whole service.
 *
 * Every few segments a small fast model folds the newly translated segments
 * into a short brief. The refresh is fire-and-forget: translation never waits
 * for it, it only ever reads the latest finished brief, so it adds no latency.
 */
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = (src: string, tgt: string) =>
  `You keep a running brief of a church sermon that is being interpreted live from ${src} into ${tgt}. You are given the current brief and the segments spoken since it was written (${src} with the ${tgt} already spoken to the congregation). Rewrite the brief to include them.

Reply with ONLY the brief, at most 130 words, in ${tgt === 'Korean' ? 'English' : tgt}, in exactly this shape (omit a line you have nothing for):
Occasion: <e.g. Sunday service, sermon title as rendered>
Passage: <book chapter:verses being preached>
Main point: <one or two sentences: what the pastor is arguing, including who should do what>
Now: <one short sentence: what he is doing at the moment, e.g. telling a story about X, reading verse Y, praying>
Names and terms: <${src} = ${tgt} as already rendered; people, places, the title, recurring key phrases; at most 10>

Record only what the segments actually say. Never predict what comes next. Keep the ${tgt} renderings exactly as already spoken.`;

export class SermonBrief {
  private brief = '';
  private pending: { source: string; target: string }[] = [];
  private inFlight = false;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly srcLabel: string,
    private readonly tgtLabel: string,
    private readonly model = process.env.BRIEF_MODEL || 'claude-haiku-5-5',
    /** Segments to collect before a refresh. */
    private readonly every = 6,
  ) {
    this.client = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 });
  }

  /** The latest finished brief, '' until the first refresh lands. */
  current(): string {
    return this.brief;
  }

  /** Record a translated segment; starts a background refresh when enough have built up. */
  note(source: string, target: string): void {
    this.pending.push({ source, target });
    if (!this.inFlight && this.pending.length >= this.every) void this.refresh();
  }

  reset(): void {
    this.brief = '';
    this.pending = [];
  }

  /** Resolves when no refresh is running. For evals, which want a deterministic order. */
  async idle(): Promise<void> {
    while (this.inFlight) await new Promise((r) => setTimeout(r, 50));
  }

  private async refresh(): Promise<void> {
    this.inFlight = true;
    const batch = this.pending;
    this.pending = [];
    try {
      const segs = batch.map((p) => `${this.srcLabel}: ${p.source}\n${this.tgtLabel}: ${p.target}`).join('\n\n');
      const r = await this.client.messages.create({
        model: this.model,
        max_tokens: 400,
        system: SYSTEM(this.srcLabel, this.tgtLabel),
        messages: [{ role: 'user', content: `Current brief:\n${this.brief || '(none yet)'}\n\nNew segments:\n\n${segs}` }],
      });
      const text = r.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (text) this.brief = text.slice(0, 1200);
    } catch (err) {
      // A failed refresh keeps the old brief; its segments are retried with the next batch.
      console.warn('[SermonBrief] refresh failed:', err instanceof Error ? err.message : err);
      this.pending = batch.concat(this.pending).slice(-30);
    } finally {
      this.inFlight = false;
    }
  }
}
