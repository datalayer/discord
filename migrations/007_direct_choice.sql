BEGIN;

-- DC-203. Idempotent; re-applied every time after 001 to 006.

-- Which server's application a person's direct messages go to, when they
-- are linked in several: their choice from the select @Datalayer sends.
-- Forgotten with them (/datalayer forget).
CREATE TABLE IF NOT EXISTS discord_direct_choice (
  application_id text NOT NULL,
  user_id text NOT NULL,
  guild_id text NOT NULL,
  chosen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, user_id)
);

COMMIT;
