/**
 * Postgres access — deliberately optional.
 *
 * Shema ran with no database at all until the glossary needed runtime edits,
 * and it must still boot without one: local development has no Postgres, and a
 * database outage must never take a Sunday service off the air. Every caller
 * therefore has to cope with `getPool()` returning null, and the glossary keeps
 * the CHURCH_GLOSSARY env vars as a read-only fallback.
 */

import { Pool, QueryResultRow } from 'pg';

let pool: Pool | null = null;

export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL?.trim() || undefined;
}

/** Whether a DATABASE_URL was supplied at all (not whether it works). */
export function isDbConfigured(): boolean {
  return Boolean(databaseUrl());
}

/**
 * Railway's private network (*.railway.internal) speaks plaintext and refuses
 * TLS, while its public proxy requires TLS with a certificate that does not
 * chain to a public root. Localhost needs nothing. Getting this wrong is the
 * usual cause of "connection terminated unexpectedly" on Railway.
 */
export function needsSsl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    if (host.endsWith('.railway.internal')) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    return true;
  } catch {
    return false;
  }
}

export function getPool(): Pool | null {
  if (!isDbConfigured()) return null;
  if (!pool) {
    const url = databaseUrl() as string;
    pool = new Pool({
      connectionString: url,
      ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined,
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    // An idle client erroring must not take the process down with it; the
    // pool replaces it and the next query reconnects.
    pool.on('error', (err) => console.error('[DB] Idle client error:', err.message));
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL is not set');
  const res = await p.query<T>(text, params as never[]);
  return res.rows;
}

/** Cheap liveness probe. Never throws — callers decide what to do about false. */
export async function dbReachable(): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  try {
    await p.query('SELECT 1');
    return true;
  } catch (err) {
    console.warn('[DB] Unreachable:', (err as Error).message);
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end().catch(() => {});
}
