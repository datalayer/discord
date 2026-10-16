BEGIN;

-- plans/DISCORD.md §5, Phase 1 (DC-102 to DC-107). Idempotent; re-applied
-- every time after the shared host schema and 001.

-- What Datalayer signs an installation's pushed deliveries with (DC-301),
-- encrypted like the host key.
ALTER TABLE discord_installation ADD COLUMN IF NOT EXISTS delivery_secret jsonb;

-- Whether a member is linked, as Datalayer last said: what the ingress reads
-- to defer privately an unlinked person's /ask (§7.1, 5). Status only; the
-- link itself is ai-agents' record.
CREATE TABLE IF NOT EXISTS discord_user_link (
  application_id text NOT NULL,
  guild_id text NOT NULL,
  user_id text NOT NULL,
  linked boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, guild_id, user_id)
);

-- One thread, one session (§2, 2): the session uid's generation, the
-- application it runs, who opened it, and the application chosen for its
-- next session (/datalayer app, start over).
CREATE TABLE IF NOT EXISTS discord_thread_binding (
  thread_key text PRIMARY KEY,
  application_id text NOT NULL,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  session_uid text,
  generation integer NOT NULL DEFAULT 0,
  deployment_uid text,
  next_deployment_uid text,
  opened_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS discord_thread_binding_installation
  ON discord_thread_binding (application_id, guild_id);

-- The running turn of a thread, claimed insert-first (§7.5): the job that
-- holds it, its lease, its run, and whether Stop was pressed.
CREATE TABLE IF NOT EXISTS discord_turn (
  thread_key text PRIMARY KEY,
  owner text NOT NULL,
  lease_until timestamptz NOT NULL,
  run_id text,
  session_uid text,
  stop_requested boolean NOT NULL DEFAULT false
);

-- What a button or modal refers to (§7.6): a custom_id carries only
-- dc:<kind>:<render id>.
CREATE TABLE IF NOT EXISTS discord_component (
  render_id text PRIMARY KEY,
  kind text NOT NULL,
  application_id text NOT NULL,
  guild_id text NOT NULL,
  owner_id text NOT NULL,
  payload jsonb NOT NULL,
  answered_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS discord_component_installation
  ON discord_component (application_id, guild_id);

-- The applications an installation allows, as Datalayer last answered them:
-- what autocomplete offers (§7.1, 5). Never an authorization.
CREATE TABLE IF NOT EXISTS discord_allowance (
  application_id text NOT NULL,
  guild_id text NOT NULL,
  allowances jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, guild_id)
);

-- The install's signed state, spent once (§3.1, DC-103), with Datalayer's
-- one-use bind code kept here, encrypted, rather than carried through
-- Discord's URLs.
CREATE TABLE IF NOT EXISTS discord_oauth_state (
  nonce text PRIMARY KEY,
  bind_code jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);

COMMIT;
