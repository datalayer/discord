BEGIN;

-- plans/DISCORD.md §5, Phase 3 (DC-301 to DC-303). Idempotent; re-applied
-- every time after the shared host schema, 001 and 002.

-- The session whose answer a turn did not show in Discord (it ended after
-- the worker stopped, or could not post): what a `turn.completed` delivery
-- finishes as a bot message (§3.8). Cleared once the answer is shown.
ALTER TABLE discord_thread_binding
  ADD COLUMN IF NOT EXISTS unshown_session_uid text;

-- An approval's rows (its thread line, its card's buttons), found by the
-- approval a delivery names (§3.6, §7.6).
CREATE INDEX IF NOT EXISTS discord_component_approval
  ON discord_component (application_id, guild_id, (payload->>'approvalId'));

COMMIT;
