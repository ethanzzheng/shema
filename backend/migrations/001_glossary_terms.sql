-- Glossary terms: the church names and vocabulary that must be recognised and
-- rendered consistently. Replaces the CHURCH_GLOSSARY env vars, which could
-- only be changed by redeploying — and a redeploy kills every live broadcast.
--
-- church_id is the normalized room slug ("hanmaum"). There is no church table
-- yet; the slug is already the tenant key everywhere else in the system, so it
-- is the key here too rather than inventing a second identity to reconcile.
--
-- session_id NULL means church scope (permanent). Non-NULL ties the term to one
-- broadcast — song titles, a visiting speaker's name.
CREATE TABLE IF NOT EXISTS glossary_terms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id   text NOT NULL,
  session_id  uuid,
  source_term text NOT NULL,
  -- 'keep'      = do not translate; carry the term across as-is/transliterated
  -- 'translate' = force the rendering held in targets
  behavior    text NOT NULL DEFAULT 'translate'
              CHECK (behavior IN ('keep', 'translate')),
  -- Per-language forced renderings, e.g. {"en": "Mokjang"}. Empty for 'keep'.
  targets     jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text
);

-- Partial: church-scope terms are unique per church, so the env->DB seed can be
-- re-run safely (ON CONFLICT DO NOTHING) and an operator cannot add the same
-- term twice. Service-scope rows are deliberately unconstrained — the same
-- term may legitimately recur across services.
CREATE UNIQUE INDEX IF NOT EXISTS glossary_terms_church_term
  ON glossary_terms (church_id, source_term) WHERE session_id IS NULL;

CREATE INDEX IF NOT EXISTS glossary_terms_church  ON glossary_terms (church_id);
CREATE INDEX IF NOT EXISTS glossary_terms_session ON glossary_terms (session_id);
