-- 026_reply_delay.sql
-- Why this exists: Adds support for deliberate send delays on send_reply steps.
--   A new run status 'waiting_to_send' holds the run while the delay elapses.
--   send_after records the timestamp when the delay worker should fire the send.
-- Touches tables: playbook_runs
-- Destructive: no

BEGIN;

ALTER TABLE playbook_runs DROP CONSTRAINT IF EXISTS playbook_runs_status_check;
ALTER TABLE playbook_runs ADD CONSTRAINT playbook_runs_status_check
  CHECK (status IN (
    'running',
    'waiting_for_customer',
    'waiting_for_human',
    'waiting_to_send',
    'complete',
    'failed',
    'escalated',
    'retrying',
    'cancelled'
  ));

ALTER TABLE playbook_runs ADD COLUMN IF NOT EXISTS send_after TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_playbook_runs_waiting_to_send
  ON playbook_runs(send_after)
  WHERE status = 'waiting_to_send';

COMMIT;
