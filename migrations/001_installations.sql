BEGIN;

-- What the service keeps. The shared tables (discord_event_claims, discord_jobs,
-- discord_usage, discord_payload_access, discord_job_replays) are the host
-- kit's: applyHostSchema(db, "discord") from
-- @datalayer/agent-runtimes/lib/portable/hosts runs before these files
-- (scripts/migrate.ts). Each file is idempotent and re-applied every time.

-- One Discord server bound to one Datalayer organization. The host key
-- is encrypted (SecretCipher, bound to `<application_id>:<guild_id>`); the
-- bot token is never stored here: it lives in the Secret and in memory.
CREATE TABLE IF NOT EXISTS discord_installation (
  application_id text NOT NULL,
  guild_id text NOT NULL,
  datalayer_host_uid text NOT NULL,
  datalayer_host_key jsonb NOT NULL,
  datalayer_organization_uid text NOT NULL,
  installed_by text NOT NULL,
  permissions text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'paused', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  PRIMARY KEY (application_id, guild_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS discord_installation_host_uid
  ON discord_installation (datalayer_host_uid);

COMMIT;
