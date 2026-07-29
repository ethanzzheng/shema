/**
 * Helpers shared by the eval runners (run.ts, run-en-ko.ts). Evals only —
 * nothing here is imported by the runtime pipeline.
 */

/** Dice-coefficient token similarity after normalization. */
export function similarity(a: string, b: string): number {
  const tok = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const ta = tok(a);
  const tb = tok(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setB = new Map<string, number>();
  for (const t of tb) setB.set(t, (setB.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of ta) {
    const n = setB.get(t) ?? 0;
    if (n > 0) {
      overlap++;
      setB.set(t, n - 1);
    }
  }
  return (2 * overlap) / (ta.length + tb.length);
}
