/**
 * One-time import of the CHURCH_GLOSSARY env vars into the database.
 *
 *   npx tsx scripts/seed-glossary.ts --dry-run
 *   npx tsx scripts/seed-glossary.ts
 *   npx tsx scripts/seed-glossary.ts --church hanmaum --church grace-church
 *
 * Idempotent: church-scope terms are unique per church, so re-running adds
 * nothing. The env vars are left in place as the read-only fallback.
 */

import 'dotenv/config';
import { closePool, isDbConfigured } from '../src/db';
import { runMigrations } from '../src/db/migrate';
import { addTerm } from '../src/glossary/repo';
import { envGlossaryPairs } from '../src/glossary/env';
import { normalizeRoomId } from '../src/session-manager';

/**
 * CHURCH_GLOSSARY_GRACE_CHURCH → "grace-church". Slugs only ever contain
 * [a-z0-9-], so underscores in the var name are always hyphens in the slug.
 */
export function churchesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((k) => k.startsWith('CHURCH_GLOSSARY_') && (env[k] ?? '').trim() !== '')
    .map((k) => normalizeRoomId(k.slice('CHURCH_GLOSSARY_'.length).replace(/_/g, '-')))
    .filter((slug, i, all) => all.indexOf(slug) === i);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const explicit: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--church' && args[i + 1]) explicit.push(normalizeRoomId(args[++i]));
  }

  const churches = explicit.length > 0 ? explicit : churchesFromEnv();
  if (churches.length === 0) {
    console.error(
      'No churches found. Set CHURCH_GLOSSARY_<SLUG>, or name one explicitly:\n' +
        '  npx tsx scripts/seed-glossary.ts --church hanmaum',
    );
    process.exitCode = 1;
    return;
  }

  if (!isDbConfigured()) {
    console.error('DATABASE_URL is not set — nothing to seed into.');
    process.exitCode = 1;
    return;
  }

  if (!dryRun) await runMigrations();

  console.log(`${dryRun ? 'DRY RUN — ' : ''}Seeding ${churches.length} church(es): ${churches.join(', ')}\n`);

  let added = 0;
  let skipped = 0;
  for (const church of churches) {
    // Global CHURCH_GLOSSARY plus that church's own var, the latter winning —
    // the same precedence the runtime fallback uses.
    const pairs = envGlossaryPairs(process.env, church);
    console.log(`${church}: ${pairs.size} term(s) in the environment`);
    for (const [sourceTerm, target] of pairs) {
      if (dryRun) {
        console.log(`   would add  ${sourceTerm} = "${target}"`);
        added++;
        continue;
      }
      const term = await addTerm({
        churchId: church,
        sourceTerm,
        behavior: 'translate',
        targets: { en: target },
        createdBy: 'seed:env',
        notes: 'Imported from CHURCH_GLOSSARY',
      });
      if (term) {
        console.log(`   added      ${sourceTerm} = "${target}"`);
        added++;
      } else {
        console.log(`   exists     ${sourceTerm}`);
        skipped++;
      }
    }
    console.log('');
  }

  console.log(`${dryRun ? 'Would add' : 'Added'} ${added}, already present ${skipped}.`);
  if (!dryRun) {
    console.log(
      '\nThe CHURCH_GLOSSARY env vars are still read as a fallback when the\n' +
        'database is unreachable. Leave them in place.',
    );
  }
  await closePool();
}

main().catch(async (err) => {
  console.error('Seed failed:', (err as Error).message);
  await closePool();
  process.exit(1);
});
