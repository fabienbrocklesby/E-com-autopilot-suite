-- 023_run_cancelled_status.sql
-- Why this exists: Add 'cancelled' to the playbook_runs status enum so that
-- manually closing a thread can explicitly cancel any in-flight playbook run,
-- distinguishing a user-initiated stop from a system failure ('failed').
-- Touches tables: playbook_runs
-- Destructive: no

BEGIN;

ALTER TABLE playbook_runs DROP CONSTRAINT IF EXISTS playbook_runs_status_check;

ALTER TABLE playbook_runs ADD CONSTRAINT playbook_runs_status_check
  CHECK (status IN (
    'running',
    'waiting_for_customer',
    'waiting_for_human',
    'complete',
    'failed',
    'escalated',
    'retrying',
    'cancelled'
  ));

COMMIT;
