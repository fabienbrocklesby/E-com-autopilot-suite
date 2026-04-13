-- Individual step execution records within a playbook run.
CREATE TABLE playbook_step_executions (
  id SERIAL PRIMARY KEY,
  run_id INT NOT NULL REFERENCES playbook_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  step_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed', 'skipped')),
  input JSONB,
  output JSONB,
  error TEXT,
  ai_calls JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX idx_step_executions_run ON playbook_step_executions(run_id);
