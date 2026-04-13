-- Per-thread playbook execution runs.
CREATE TABLE playbook_runs (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id INT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  playbook_id INT NOT NULL REFERENCES playbooks(id),
  playbook_version INT NOT NULL,
  current_step_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting_for_customer', 'waiting_for_human', 'complete', 'failed', 'escalated')),
  context JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_playbook_runs_thread ON playbook_runs(thread_id);
CREATE INDEX idx_playbook_runs_status ON playbook_runs(workspace_id, status);
CREATE TRIGGER trg_playbook_runs_updated_at BEFORE UPDATE ON playbook_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
