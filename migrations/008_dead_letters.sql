BEGIN;

-- DC-403. Idempotent; re-applied every time after 001 to 007.

-- The two maintenance writes that reach dead jobs, as functions of the
-- tables' owner: once the tables belong to discord_owner and the service's
-- role sees the queue without its dead jobs (migrations/roles/), the service
-- still drops spent interaction tokens and forgets a person's requests,
-- dead ones included, without reading a dead job's payload. Until then the
-- service's role owns them, and they run as it.

-- Every queued or dead job's spent interaction token (DC-102): how many.
CREATE OR REPLACE FUNCTION discord_drop_spent_tokens(before bigint)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH dropped AS (
    UPDATE public.discord_jobs SET payload = payload - 'token'
     WHERE payload->>'kind' = 'interaction' AND payload ? 'token'
       AND (payload->>'receivedAt')::bigint < before
    RETURNING 1
  )
  SELECT count(*) FROM dropped
$$;

-- A person's queued and dead requests (DC-106); the one running now is
-- deleted by the queue when it is done. How many.
CREATE OR REPLACE FUNCTION discord_forget_jobs(application_id text, user_id text)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH forgotten AS (
    DELETE FROM public.discord_jobs
     WHERE state <> 'processing'
       AND payload->>'kind' = 'interaction'
       AND payload#>>'{key,applicationId}' = application_id
       AND payload->>'userId' = user_id
    RETURNING 1
  )
  SELECT count(*) FROM forgotten
$$;

REVOKE ALL ON FUNCTION discord_drop_spent_tokens(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION discord_forget_jobs(text, text) FROM PUBLIC;

-- Which database role read a payload or replayed a job: the credential that
-- authenticated the operator, beside the name they gave. Rows from before
-- this migration have none.
ALTER TABLE discord_payload_access ADD COLUMN IF NOT EXISTS database_role text;
ALTER TABLE discord_payload_access ALTER COLUMN database_role SET DEFAULT session_user;
ALTER TABLE discord_job_replays ADD COLUMN IF NOT EXISTS database_role text;
ALTER TABLE discord_job_replays ALTER COLUMN database_role SET DEFAULT session_user;

COMMIT;
