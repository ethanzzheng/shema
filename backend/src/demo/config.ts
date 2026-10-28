/**
 * Demo funnel limits.
 *
 * Every number here is an env var so it can be tuned on Railway without a
 * deploy. The defaults come from measuring two real services: a sermon
 * produces roughly 800-1,400 TTS characters per minute (median segment 64-66
 * characters). ElevenLabs Flash v2.5 bills 0.5-1 credit per character at about
 * $0.00017 a credit, so demo TTS costs on the order of $0.09-0.19 a minute.
 * That figure sets every cap below.
 */

const bool = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
};

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Rooms in this namespace are demos: capped, throwaway, never a real church. */
export const DEMO_PREFIX = 'demo-';

export const demoConfig = {
  /**
   * Whether the demo stops at a sign-in wall partway through.
   *
   * Off by default: the wall costs a conversion step and the account it
   * created bought little that the daily ceiling does not already protect.
   * With it off, every visitor gets the whole thing — real voice and the
   * phone listener — and cost is held by the per-session, per-IP and daily
   * caps below instead of by an identity. The Clerk path is intact and comes
   * back by setting this true; nothing about it was removed.
   */
  requireSignIn: () => bool('DEMO_REQUIRE_SIGNIN', false),

  /**
   * How long one visitor's demo runs, and how many segments it translates.
   * With no wall these bound the whole session rather than a first stage.
   */
  anonSeconds: () => num('DEMO_ANON_SECONDS', 180),
  anonSegments: () => num('DEMO_ANON_SEGMENTS', 30),

  /**
   * Real speech an ANONYMOUS visitor gets before the wall. A browser voice is
   * audibly robotic, which undersells the product at the exact moment it is
   * trying to impress someone, so the first stretch is the genuine voice and
   * the fallback becomes the argument for signing in. At ~1,100 characters a
   * minute this is roughly $0.04-0.08 a visitor.
   */
  /**
   * With the wall off this is a visitor's entire speech allowance. It covers
   * the whole demo (plus headroom, since the character conversion below is an
   * estimate), so a visitor never hears the voice cut out partway: the demo's
   * own length is the real limit, roughly $0.30-1.00 a full demo. The daily
   * ceiling is what caps the bill; this only stops one visitor draining it.
   */
  anonTtsSeconds: () => num('DEMO_ANON_TTS_SECONDS', num('DEMO_ANON_SECONDS', 180) + 30),

  /**
   * Signed-in stage, per account, for the life of that account. Five minutes
   * is about $0.45-0.95 of TTS. The convincing happens in the first ninety
   * seconds plus the moment they hear it on their own phone; ten minutes
   * doubles the cost per lead without doubling the persuasion.
   */
  ttsSecondsPerAccount: () => num('DEMO_TTS_SECONDS_PER_ACCOUNT', 300),

  /**
   * Global ceiling across all demos in a day. At ~1,100 characters a minute,
   * 40,000 characters is roughly seven full five-minute demos, or $3-7 a day.
   * Past it, demos keep working but fall back to captions only.
   */
  ttsDailyBudgetChars: () => num('DEMO_TTS_DAILY_BUDGET_CHARS', 40_000),

  /** A demo room is reclaimed this long after it was created, used or not. */
  sessionTtlSeconds: () => num('DEMO_SESSION_TTL_SECONDS', 900),

  /** Anonymous demo starts allowed from one address per hour. */
  anonStartsPerIpPerHour: () => num('DEMO_ANON_STARTS_PER_IP_PER_HOUR', 5),

  /**
   * Characters per second of speech, used to convert the per-account second
   * budget into the character budget ElevenLabs actually bills. Measured
   * across two services; deliberately an env var because it is an estimate.
   */
  charsPerSecond: () => num('DEMO_TTS_CHARS_PER_SECOND', 18),
} as const;

/** The per-account cap expressed in the unit ElevenLabs bills in. */
export function perAccountCharCap(): number {
  return Math.round(demoConfig.ttsSecondsPerAccount() * demoConfig.charsPerSecond());
}

/** The anonymous taste, in the same unit. */
export function anonCharCap(): number {
  return Math.round(demoConfig.anonTtsSeconds() * demoConfig.charsPerSecond());
}

export function isDemoRoom(roomId: string): boolean {
  return roomId.startsWith(DEMO_PREFIX);
}
