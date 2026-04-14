-- Phase 6: Retry queue for failed steps

ALTER TABLE playbook_runs ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;
ALTER TABLE playbook_runs ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

-- Add 'retrying' to the allowed status values
ALTER TABLE playbook_runs DROP CONSTRAINT IF EXISTS playbook_runs_status_check;
ALTER TABLE playbook_runs ADD CONSTRAINT playbook_runs_status_check
  CHECK (status IN ('running', 'waiting_for_customer', 'waiting_for_human', 'complete', 'failed', 'escalated', 'retrying'));

CREATE INDEX IF NOT EXISTS idx_playbook_runs_retrying
  ON playbook_runs(next_retry_at)
  WHERE status = 'retrying';
