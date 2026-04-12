-- Migration: 005_sheet_rules
-- Introduces the user-configurable sheet rules system.
-- Each rule defines how to match an email to a sheet row and what to update.
-- Executions track every attempt (pending review or auto-applied).

CREATE TABLE sheet_rules (
  id                 SERIAL PRIMARY KEY,
  workspace_id       INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  -- NULL means the rule applies to all categories; an array restricts it.
  category_ids       INTEGER[] DEFAULT NULL,
  -- AI instruction used to extract the match value from email content.
  match_instruction  TEXT NOT NULL,
  -- Sheet column header to match the extracted value against (e.g. "Order/Item").
  match_column       TEXT NOT NULL,
  -- Array of update definitions. Each element:
  --   { "column": "Status", "mode": "fixed", "value": "Refunded" }
  --   { "column": "Things to add", "mode": "ai", "instruction": "Summarise request" }
  updates            JSONB NOT NULL DEFAULT '[]',
  -- When true the update is written to the sheet immediately on match.
  -- When false it goes to the review queue for manual approval.
  auto_apply         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sheet_rules_workspace_active_idx ON sheet_rules (workspace_id, is_active);

CREATE TABLE sheet_rule_executions (
  id                SERIAL PRIMARY KEY,
  workspace_id      INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_id           INT NOT NULL REFERENCES sheet_rules(id) ON DELETE CASCADE,
  thread_id         INT REFERENCES threads(id) ON DELETE SET NULL,
  row_number        INT,
  match_value       TEXT,
  -- Resolved proposed updates: { "Status": "Refunded", "Things to add": "..." }
  proposed_updates  JSONB NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'failed')),
  applied_at        TIMESTAMPTZ,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sheet_rule_executions_workspace_status_idx ON sheet_rule_executions (workspace_id, status);
CREATE INDEX sheet_rule_executions_rule_idx ON sheet_rule_executions (rule_id);
CREATE INDEX sheet_rule_executions_thread_idx ON sheet_rule_executions (thread_id);

-- updated_at trigger for sheet_rules
CREATE TRIGGER trg_sheet_rules_updated_at
  BEFORE UPDATE ON sheet_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
