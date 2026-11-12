BEGIN;

-- What an installation's delivery secret is derived under at Datalayer: the
-- key (`ai-agents-host-deliveries-v<N>`, not a secret) and the
-- registration's version, written with the secret. A secret kept without a
-- key was derived from the platform's shared secret: its pushes are accepted
-- until 31 December 2026, 00:00 UTC only, and the service registers such a
-- webhook again as soon as Datalayer asks (GET /apps/hosts/self answers
-- delivery.renew). Idempotent; re-applied every time after 001 to 010.
ALTER TABLE discord_installation ADD COLUMN IF NOT EXISTS delivery_key text;
ALTER TABLE discord_installation ADD COLUMN IF NOT EXISTS delivery_version integer;

COMMIT;
