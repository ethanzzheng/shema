-- Demo funnel: usage accounting and funnel events.
--
-- Demo sessions themselves are never persisted — they live and die in memory
-- like every other room. Two things DO have to outlive a request:
--
--   1. TTS spend, because the caps are worthless if a redeploy resets them.
--      ElevenLabs is the real cost here, and the client is assumed hostile.
--   2. Funnel events, which are the only way to tell whether the funnel works.
CREATE TABLE IF NOT EXISTS demo_tts_usage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Clerk user id. Anonymous demos never reach TTS, so this is always set.
  clerk_user_id text NOT NULL,
  chars         integer NOT NULL CHECK (chars >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- "How much has this account spent" and "how much has today spent" are the
-- only two questions asked, and both run before every demo TTS call.
CREATE INDEX IF NOT EXISTS demo_tts_usage_user ON demo_tts_usage (clerk_user_id);
CREATE INDEX IF NOT EXISTS demo_tts_usage_created ON demo_tts_usage (created_at DESC);

CREATE TABLE IF NOT EXISTS demo_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The demo room this happened in, so a funnel can be followed end to end.
  session_id    text,
  event         text NOT NULL,
  clerk_user_id text,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS demo_events_created ON demo_events (created_at DESC);
CREATE INDEX IF NOT EXISTS demo_events_event ON demo_events (event, created_at DESC);
