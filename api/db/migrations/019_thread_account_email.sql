-- 019_thread_account_email.sql
-- Associates each thread with the Google account that ingested it.
-- Without this, switching Google accounts shows threads from the old account.
-- Old threads get account_email = '' and are effectively hidden after the switch.
-- Touches tables: threads
-- Destructive: no - old threads are preserved but will no longer appear in the UI
--              for any connected account (they have no account_email set).

BEGIN;

ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS account_email TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_threads_account_email ON threads(workspace_id, account_email);

COMMIT;
