-- Per-service transcripts.
--
-- Shema produced a full bilingual transcript of every sermon and then threw it
-- away. Churches want it (sermon notes, newsletters, members who missed the
-- service) and the operator needs it to see what the system actually output —
-- which is also where proper-noun misses get spotted and turned into glossary
-- terms.
--
-- church_id is the normalized room slug, the same tenant key the glossary uses.
-- session_id is the broadcast's existing in-memory id, so a mid-service
-- reconnect resumes the SAME transcript instead of splitting it in two.
--
-- Text only. No audio is stored.
CREATE TABLE IF NOT EXISTS transcripts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id    text NOT NULL,
  session_id   uuid NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  source_lang  text NOT NULL,
  target_langs text[] NOT NULL DEFAULT '{}',
  -- 'live' while broadcasting; 'complete' once the session ends cleanly. A
  -- transcript left 'live' by a crash still has its segments and is viewable.
  status       text NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'complete'))
);

-- One transcript per broadcast. Makes the writer's upsert-on-start idempotent,
-- so a reconnect finds the existing row rather than creating a second one.
CREATE UNIQUE INDEX IF NOT EXISTS transcripts_session ON transcripts (session_id);
-- The list view is "this church's services, newest first" and nothing else.
CREATE INDEX IF NOT EXISTS transcripts_church_started
  ON transcripts (church_id, started_at DESC);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transcript_id uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  -- Milliseconds from the transcript's started_at, so playback position is
  -- meaningful without depending on wall-clock skew between services.
  offset_ms     integer NOT NULL DEFAULT 0,
  source_text   text NOT NULL,
  -- Keyed by output language, e.g. {"en": {"sermon": "...", "direct": "..."}}.
  -- Shema produces TWO renderings in one language rather than several
  -- languages: `sermon` is the natural preached form that gets spoken, and
  -- `direct` is the literal translation. Keeping the language key means real
  -- multi-language support later needs no migration.
  translations  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Segments are only ever read as "the whole transcript, in spoken order", and
-- the unique part makes the batched writer's retry safe to re-run.
CREATE UNIQUE INDEX IF NOT EXISTS transcript_segments_unique
  ON transcript_segments (transcript_id, seq);
