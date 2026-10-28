BEGIN;

-- A Discord application the person brings (decided 28 October 2026): their
-- own application, whose bot they added to their server themselves, installed
-- from a Datalayer application's Ship tab with its application id, public key
-- and bot token. Its installation is a row of discord_installation like any
-- server's (its key from Datalayer, its allowances); what is kept here is
-- what only a custom application has: its public key, with which the
-- service verifies the interactions Discord posts to
-- /discord/interactions/<application_id>, and its bot token (SecretCipher,
-- bound to `custom-app:<application_id>`), with which the service posts as
-- that bot and holds its gateway connection. Idempotent; re-applied every
-- time after 001 to 009.
CREATE TABLE IF NOT EXISTS discord_custom_app (
  application_id text PRIMARY KEY,
  public_key text NOT NULL,
  bot_token jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
