-- 018_human_interventions.sql
-- Why this exists: Tracks when a human operator sends a manual reply to a customer
-- directly from the dashboard (bypassing the playbook draft flow). Records the
-- timestamp on the thread row so the UI can display "Human intervened on <date>"
-- even when no playbook run is active.
-- Touches tables: threads
-- Destructive: no

BEGIN;

ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS last_manual_reply_at TIMESTAMPTZ;

COMMIT;
