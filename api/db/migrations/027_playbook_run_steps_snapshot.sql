-- 027_playbook_run_steps_snapshot.sql
-- Why this exists: A run must continue against the playbook shape it started
-- with. If the live playbook is edited while a run is paused, current_step_id
-- can point at a step that no longer exists.
-- Touches tables: playbook_runs
-- Destructive: no

BEGIN;

ALTER TABLE playbook_runs
  ADD COLUMN IF NOT EXISTS steps_snapshot JSONB;

UPDATE playbook_runs pr
SET steps_snapshot = p.steps
FROM playbooks p
WHERE pr.playbook_id = p.id
  AND pr.steps_snapshot IS NULL;

UPDATE playbook_runs pr
SET status = 'cancelled',
    context = context || jsonb_build_object(
      '_cancelled_reason', 'Current step no longer exists in playbook snapshot during migration 027.',
      '_cancelled_at', NOW()
    )
WHERE pr.status IN ('running', 'waiting_for_customer', 'waiting_for_human', 'waiting_to_send', 'retrying')
  AND pr.current_step_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(pr.steps_snapshot) AS step
    WHERE step->>'id' = pr.current_step_id
  );

COMMIT;
