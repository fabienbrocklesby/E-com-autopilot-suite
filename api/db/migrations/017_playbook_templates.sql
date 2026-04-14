-- Playbook template library: pre-built playbooks for quick onboarding
CREATE TABLE playbook_templates (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  industry TEXT,
  description TEXT NOT NULL,
  plain_language TEXT NOT NULL,
  steps JSONB NOT NULL,
  voice_examples TEXT,
  required_sheet_columns TEXT[],
  is_official BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_playbook_templates_category ON playbook_templates (category);
CREATE INDEX idx_playbook_templates_industry ON playbook_templates (industry);
