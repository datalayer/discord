BEGIN;

-- Linking. Idempotent; re-applied every time after 001 to 008.

-- Until when a link code issued to the member can still be confirmed at
-- Datalayer. While it is set and the row says not linked, the ingress asks
-- ai-agents (the link's record) before deferring an /ask, so the first
-- question after confirming on the web is answered in public with its
-- thread; it is cleared once the member is linked, or once the code has
-- expired and ai-agents still says not linked.
ALTER TABLE discord_user_link ADD COLUMN IF NOT EXISTS pending_until timestamptz;

COMMIT;
