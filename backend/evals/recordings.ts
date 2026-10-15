/**
 * Where local test media and pilot-run output live. Everything here is
 * gitignored (it is a named church's service content, and the clips are
 * large), so it exists only on the machine that recorded it.
 *
 *   recordings/<language>/audio/        source recordings of real services
 *   recordings/<language>/transcripts/  what the congregation heard, live
 *   recordings/<language>/runs/<label>/ pilot-run artifacts
 *
 * <language> is the language the pastor SPEAKS — the source side of the
 * direction — so ko-en runs go under korean/, zh-en under mandarin/, and a
 * future en-ko run under english/.
 */
import fs from 'fs';
import path from 'path';

export const RECORDINGS_DIR = path.join(__dirname, '../../recordings');

const SOURCE_LANGUAGE: Record<string, string> = {
  'ko-en': 'korean',
  'en-ko': 'english',
  'zh-en': 'mandarin',
  'yue-en': 'cantonese',
};

export function languageFor(direction: string): string {
  return SOURCE_LANGUAGE[direction] ?? direction.split('-')[0];
}

export function runsDir(direction: string): string {
  return path.join(RECORDINGS_DIR, languageFor(direction), 'runs');
}

/**
 * Find an existing run by label in any language. Labels are unique in
 * practice; if two languages share one, the first found wins and a
 * `--direction` would be needed to disambiguate.
 */
export function findRunDir(label: string, direction?: string): string {
  if (direction) return path.join(runsDir(direction), label);
  const langs = fs.existsSync(RECORDINGS_DIR) ? fs.readdirSync(RECORDINGS_DIR) : [];
  for (const lang of langs) {
    const dir = path.join(RECORDINGS_DIR, lang, 'runs', label);
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(`no run "${label}" under ${RECORDINGS_DIR}/*/runs/`);
}
