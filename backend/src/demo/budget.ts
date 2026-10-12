/**
 * Demo spend control.
 *
 * Every check here runs server-side and is written as if the client were
 * hostile, because for a public URL on a cold-email funnel it eventually is.
 * TTS spend is recorded in Postgres rather than memory precisely so a redeploy
 * cannot reset somebody's allowance.
 */

import { isDbConfigured, query } from '../db';
import { anonCharCap, demoConfig, perAccountCharCap } from './config';

export type TtsDecision =
  | { allowed: true }
  | { allowed: false; reason: 'account-cap' | 'daily-budget'; message: string };

/**
 * Whether this account may still generate speech. Two independent ceilings:
 * what this account has spent, and what every demo together has spent today.
 *
 * Fails CLOSED on a database error. A demo falling back to captions is a worse
 * demo; an uncapped TTS endpoint on a public page is a bill.
 */
/**
 * Whether the day's global ceiling still has room. Checked for anonymous
 * visitors too: they now spend real money, and an uncapped public page is a
 * bill no matter who is holding it.
 */
export async function dailyBudgetHasRoom(): Promise<boolean> {
  if (!isDbConfigured()) return false;
  try {
    const rows = await query<{ today: string | null }>(
      `SELECT SUM(chars) AS today FROM demo_tts_usage WHERE created_at >= date_trunc('day', now())`,
    );
    return Number(rows[0]?.today ?? 0) < demoConfig.ttsDailyBudgetChars();
  } catch (err) {
    console.warn('[Demo] Daily budget check failed, denying:', (err as Error).message);
    return false;
  }
}

/** The ledger key for anonymous spend, so it counts toward the daily ceiling. */
export const ANON_LEDGER_KEY = 'anon';

/**
 * Whether an anonymous visitor may still hear the real voice. Two ceilings:
 * this session's taste, and the day's global spend.
 */
export async function mayUseAnonTts(usedChars: number): Promise<TtsDecision> {
  if (usedChars >= anonCharCap()) {
    return {
      allowed: false,
      reason: 'account-cap',
      message: 'Sign in to keep hearing the natural voice.',
    };
  }
  if (!(await dailyBudgetHasRoom())) {
    return {
      allowed: false,
      reason: 'daily-budget',
      message: "Today's voice allowance is used up. Captions are still live.",
    };
  }
  return { allowed: true };
}

export async function mayUseTts(clerkUserId: string): Promise<TtsDecision> {
  if (!isDbConfigured()) {
    return {
      allowed: false,
      reason: 'daily-budget',
      message: 'Voice preview is unavailable right now. Captions are still live.',
    };
  }
  try {
    const rows = await query<{ account: string | null; today: string | null }>(
      `SELECT
         (SELECT SUM(chars) FROM demo_tts_usage WHERE clerk_user_id = $1) AS account,
         (SELECT SUM(chars) FROM demo_tts_usage WHERE created_at >= date_trunc('day', now())) AS today`,
      [clerkUserId],
    );
    const account = Number(rows[0]?.account ?? 0);
    const today = Number(rows[0]?.today ?? 0);

    if (account >= perAccountCharCap()) {
      return {
        allowed: false,
        reason: 'account-cap',
        message: "That's the end of the voice preview for this account.",
      };
    }
    if (today >= demoConfig.ttsDailyBudgetChars()) {
      return {
        allowed: false,
        reason: 'daily-budget',
        message: "Today's voice preview allowance is used up. Captions are still live.",
      };
    }
    return { allowed: true };
  } catch (err) {
    console.warn('[Demo] TTS budget check failed, denying:', (err as Error).message);
    return {
      allowed: false,
      reason: 'daily-budget',
      message: 'Voice preview is unavailable right now. Captions are still live.',
    };
  }
}

/** Record spend. Never throws: the audio has already been produced. */
export async function recordTtsSpend(clerkUserId: string, chars: number): Promise<void> {
  if (!isDbConfigured() || chars <= 0) return;
  try {
    await query('INSERT INTO demo_tts_usage (clerk_user_id, chars) VALUES ($1, $2)', [
      clerkUserId,
      Math.round(chars),
    ]);
  } catch (err) {
    console.warn('[Demo] Could not record TTS spend:', (err as Error).message);
  }
}

/** What an account has left, for the UI to show a countdown honestly. */
export async function remainingForAccount(clerkUserId: string): Promise<number> {
  if (!isDbConfigured()) return 0;
  try {
    const rows = await query<{ sum: string | null }>(
      'SELECT SUM(chars) AS sum FROM demo_tts_usage WHERE clerk_user_id = $1',
      [clerkUserId],
    );
    return Math.max(0, perAccountCharCap() - Number(rows[0]?.sum ?? 0));
  } catch {
    return 0;
  }
}

/**
 * Per-IP throttle on anonymous demo starts. In memory on purpose: it only has
 * to blunt a burst from one address, addresses rotate anyway, and a restart
 * clearing it costs nothing — unlike the TTS ledger, which must survive.
 */
const starts = new Map<string, number[]>();

export function mayStartAnonDemo(ip: string): boolean {
  const limit = demoConfig.anonStartsPerIpPerHour();
  if (limit === 0) return true;
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const seen = (starts.get(ip) ?? []).filter((t) => t > hourAgo);
  if (seen.length >= limit) {
    starts.set(ip, seen);
    return false;
  }
  seen.push(now);
  starts.set(ip, seen);
  // The map would otherwise grow for the life of the process.
  if (starts.size > 5000) {
    for (const [k, v] of starts) if (v.every((t) => t <= hourAgo)) starts.delete(k);
  }
  return true;
}

/** Visible for tests. */
export function __resetIpLimiter(): void {
  starts.clear();
}
