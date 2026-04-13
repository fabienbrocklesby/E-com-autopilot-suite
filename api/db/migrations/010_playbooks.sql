-- Playbook definitions: each category can have one active playbook.
CREATE TABLE playbooks (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category_id INT REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  plain_language_description TEXT,
  steps JSONB NOT NULL DEFAULT '[]',
  version INT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_playbooks_workspace ON playbooks(workspace_id);
CREATE INDEX idx_playbooks_category ON playbooks(category_id);
CREATE TRIGGER trg_playbooks_updated_at BEFORE UPDATE ON playbooks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
