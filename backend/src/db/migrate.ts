/**
 * Migration runner.
 *
 * Railway has no release phase, so migrations run at boot, before the server
 * starts listening. An advisory lock serialises concurrent boots so two
 * instances cannot apply the same file twice; each file is applied inside its
 * own transaction so a failure leaves nothing half-applied.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getPool } from './index';

// Resolves to backend/migrations from both src/db (ts-node-dev) and dist/db
// (compiled), which are the same depth below backend/.
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

// Arbitrary but fixed: any other advisory lock in this database must not reuse it.
const MIGRATION_LOCK_ID = 8_274_113;

export async function runMigrations(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  const client = await pool.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name       text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      const applied = new Set(
        (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
          (r) => r.name,
        ),
      );
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      let ran = 0;
      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
          console.log(`[DB] Applied migration ${file}`);
          ran++;
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
        }
      }
      if (ran === 0) console.log(`[DB] Schema up to date (${files.length} migration(s))`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}
