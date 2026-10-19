BEGIN;

-- DC-403. The role split, applied after migrations/ by `migrate --roles` as
-- discord_owner, every time; idempotent. Not part of the ordinary sequence:
-- it needs the roles, the two schemas and the tables' ownership moved once
-- by a superuser (docs/operations.md).
--
-- discord_owner owns every table and function and runs the migrations.
-- The service's role (`discord.service_role`, set by the migrate script)
-- reaches its tables, and the queue through the view <service role>.discord_jobs,
-- which has no dead job; the default search_path ("$user", public) puts that
-- view before the table, which it may not read. discord_dead_letters reaches
-- dead jobs only, through discord_dead_letters.discord_jobs, and writes the
-- audit (discord_payload_access, discord_job_replays), which it may not read
-- or change. The service's role does not reach the audit at all.

DO $roles$
DECLARE
  service text := current_setting('discord.service_role');
  stray text;
  who text;
  one record;
BEGIN
  IF current_user <> 'discord_owner' THEN
    RAISE EXCEPTION 'The roles step runs as discord_owner, not %.', current_user;
  END IF;
  IF service IN ('discord_owner', 'discord_dead_letters') OR service !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'The service''s role cannot be %.', service;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = service)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'discord_dead_letters') THEN
    RAISE EXCEPTION 'The roles % and discord_dead_letters must exist.', service;
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO stray FROM (
    SELECT n.nspname || '.' || c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname LIKE 'discord\_%'
       AND c.relkind IN ('r', 'S', 'v', 'p')
       AND pg_get_userbyid(c.relowner) <> 'discord_owner'
    UNION ALL
    SELECT n.nspname || '.' || p.proname || '()'
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'discord\_%'
       AND pg_get_userbyid(p.proowner) <> 'discord_owner'
    UNION ALL
    SELECT 'schema ' || wanted
      FROM unnest(ARRAY[service, 'discord_dead_letters']) AS wanted
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_namespace
        WHERE nspname = wanted AND pg_get_userbyid(nspowner) = 'discord_owner')
  ) AS missing;
  IF stray IS NOT NULL THEN
    RAISE EXCEPTION 'Not owned by discord_owner: %. A superuser moves them once (docs/operations.md, Database roles).', stray;
  END IF;

  -- Whatever was granted before (the one-time step keeps the service
  -- running meanwhile) is taken back, then granted again here.
  FOREACH who IN ARRAY ARRAY[service, 'discord_dead_letters'] LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', who);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', who);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', who);
  END LOOP;

  -- The service: its tables, never the queue's table or the audit.
  FOR one IN
    SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname LIKE 'discord\_%' AND c.relkind IN ('r', 'p', 'S')
       AND c.relname NOT IN ('discord_jobs', 'discord_payload_access', 'discord_job_replays',
                             'discord_payload_access_id_seq', 'discord_job_replays_id_seq')
  LOOP
    IF one.relkind = 'S' THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I', one.relname, service);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO %I', one.relname, service);
    END IF;
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.discord_drop_spent_tokens(bigint) TO %I', service);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.discord_forget_jobs(text, text) TO %I', service);

  -- The queue without its dead jobs. security_barrier: no function of the
  -- service's sees a row the view leaves out.
  EXECUTE format(
    'CREATE OR REPLACE VIEW %I.discord_jobs WITH (security_barrier) AS
       SELECT * FROM public.discord_jobs WHERE state <> ''dead''', service);
  EXECUTE format('REVOKE ALL ON %I.discord_jobs FROM PUBLIC', service);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.discord_jobs TO %I', service, service);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', service, service);

  -- The dead letters: dead jobs only; a replay changes a job's state, its
  -- attempts and when it is available, nothing else (never a payload).
  CREATE OR REPLACE VIEW discord_dead_letters.discord_jobs WITH (security_barrier) AS
    SELECT * FROM public.discord_jobs WHERE state = 'dead';
  REVOKE ALL ON discord_dead_letters.discord_jobs FROM PUBLIC;
  GRANT SELECT, UPDATE (state, attempts, available_at, last_error)
    ON discord_dead_letters.discord_jobs TO discord_dead_letters;
  GRANT USAGE ON SCHEMA discord_dead_letters TO discord_dead_letters;
  GRANT INSERT ON public.discord_payload_access, public.discord_job_replays TO discord_dead_letters;
  GRANT USAGE ON SEQUENCE public.discord_payload_access_id_seq, public.discord_job_replays_id_seq
    TO discord_dead_letters;
END
$roles$;

COMMIT;
