-- 020_playbook_runs_cascade_delete.sql
-- Why this exists: Deleting a playbook fails with a FK violation because
--   playbook_runs.playbook_id had no ON DELETE action. Adding CASCADE so that
--   deleting a playbook also removes its runs (and via existing cascade,
--   their step executions too).
-- Touches tables: playbook_runs
-- Destructive: yes - existing runs for a deleted playbook are removed with the playbook.
--   Runs for surviving playbooks are unaffected.

BEGIN;

ALTER TABLE playbook_runs
  DROP CONSTRAINT playbook_runs_playbook_id_fkey;

ALTER TABLE playbook_runs
  ADD CONSTRAINT playbook_runs_playbook_id_fkey
    FOREIGN KEY (playbook_id) REFERENCES playbooks(id) ON DELETE CASCADE;

COMMIT;
