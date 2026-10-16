BEGIN;

-- DC-307. Idempotent; re-applied every time after 001 to 003.

-- How the server hears @Datalayer's routine posts (an answer delivered
-- later): quiet (SUPPRESS_NOTIFICATIONS) or noisy. Set by an owner with
-- `/datalayer-admin notifications`; a new install starts quiet.
ALTER TABLE discord_installation
  ADD COLUMN IF NOT EXISTS notifications text NOT NULL DEFAULT 'quiet'
    CHECK (notifications IN ('quiet', 'noisy'));

COMMIT;
