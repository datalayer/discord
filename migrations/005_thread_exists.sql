BEGIN;

-- DC-304. Idempotent; re-applied every time after 001 to 004.

-- Whether the binding's thread exists in Discord (started on the answer, or
-- the thread it was asked in): where a later turn of the session, such as
-- the answer to a question pressed by its person, is posted as the bot.
ALTER TABLE discord_thread_binding
  ADD COLUMN IF NOT EXISTS thread_exists boolean NOT NULL DEFAULT false;

COMMIT;
