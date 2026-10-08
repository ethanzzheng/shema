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
   * Anonymous stage is captions only and never reaches TTS, so these bound
   * abuse rather than cost — the spend is Deepgram and Claude, both far
   * cheaper per minute than ElevenLabs.
   */
  anonSeconds: () => num('DEMO_ANON_SECONDS', 90),
  anonSegments: () => num('DEMO_ANON_SEGMENTS', 12),

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

export function isDemoRoom(roomId: string): boolean {
  return roomId.startsWith(DEMO_PREFIX);
}
