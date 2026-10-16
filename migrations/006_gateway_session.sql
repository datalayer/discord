BEGIN;

-- DC-201. Idempotent; re-applied every time after 001 to 005.

-- The gateway session a stopping leader leaves for the next one (a
-- rollout): resumed with the bot token, so the session outlives the pod.
-- Read and cleared by the replica that takes the leader lock.
CREATE TABLE IF NOT EXISTS discord_gateway_session (
  application_id text PRIMARY KEY,
  session_id text NOT NULL,
  resume_url text NOT NULL,
  seq bigint,
  saved_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
