-- Migration 002: Multi-workspace support
-- Adds workspaces, sheet_columns, sheet_updates, interactions tables.
-- Retrofits workspace_id onto existing tables.
-- Adds draft tracking columns (was_auto_sent, was_edited, final_body, sent_at, ai_model_used).
-- Adds thread_summary to threads.
-- Adds gmail_label_id to categories.

-- ─── 1. Create workspaces table ───────────────────────────────────────────────

CREATE TABLE workspaces (
  id              SERIAL      PRIMARY KEY,
  name            TEXT        NOT NULL,
  gmail_address   TEXT,
  sheet_id        TEXT,
  sheet_name      TEXT        NOT NULL DEFAULT 'Sheet1',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER set_workspaces_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Insert the default workspace so existing rows can reference id=1
INSERT INTO workspaces (id, name) VALUES (1, 'Default');

-- Advance the sequence past 1 so next INSERT gets id=2
SELECT setval('workspaces_id_seq', 1);

-- ─── 2. Retrofit workspace_id onto categories ─────────────────────────────────

ALTER TABLE categories
  ADD COLUMN workspace_id INT REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE categories SET workspace_id = 1;

ALTER TABLE categories
  ALTER COLUMN workspace_id SET NOT NULL;

-- ─── 3. Retrofit workspace_id onto threads ────────────────────────────────────

ALTER TABLE threads
  ADD COLUMN workspace_id INT REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE threads SET workspace_id = 1;

ALTER TABLE threads
  ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE threads
  ADD COLUMN thread_summary TEXT;

-- ─── 4. Retrofit workspace_id onto oauth_tokens ───────────────────────────────

ALTER TABLE oauth_tokens
  ADD COLUMN workspace_id INT REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE oauth_tokens SET workspace_id = 1;

ALTER TABLE oauth_tokens
  ALTER COLUMN workspace_id SET NOT NULL;

-- last_history_id enables incremental history.list calls for the fallback poller
ALTER TABLE oauth_tokens
  ADD COLUMN last_history_id TEXT;

-- ─── 5. Settings: replace unique constraint with composite ────────────────────

ALTER TABLE settings
  ADD COLUMN workspace_id INT REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE settings SET workspace_id = 1;

ALTER TABLE settings
  ALTER COLUMN workspace_id SET NOT NULL;

-- Drop the old single-column unique constraint (may be named settings_key_key)
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_key_key;

-- Add composite unique so different workspaces can have the same key
CREATE UNIQUE INDEX settings_workspace_key_uidx ON settings (workspace_id, key);

-- ─── 6. Gmail label ID on categories ─────────────────────────────────────────

ALTER TABLE categories
  ADD COLUMN gmail_label_id TEXT;

-- ─── 7. Draft tracking columns ───────────────────────────────────────────────

ALTER TABLE drafts
  ADD COLUMN was_auto_sent  BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN was_edited     BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN final_body     TEXT,
  ADD COLUMN sent_at        TIMESTAMPTZ,
  ADD COLUMN ai_model_used  TEXT;

-- ─── 8. sheet_columns ────────────────────────────────────────────────────────
-- Maps spreadsheet column letters to human-readable header names per workspace.

CREATE TABLE sheet_columns (
  id            SERIAL      PRIMARY KEY,
  workspace_id  INT         NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  column_letter TEXT        NOT NULL,
  header_name   TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, column_letter)
);

CREATE TRIGGER set_sheet_columns_updated_at
  BEFORE UPDATE ON sheet_columns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── 9. sheet_updates ────────────────────────────────────────────────────────
-- Audit log of every AI-triggered write attempt to Google Sheets.

CREATE TABLE sheet_updates (
  id            SERIAL      PRIMARY KEY,
  workspace_id  INT         NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id     INT         REFERENCES threads(id) ON DELETE SET NULL,
  column_letter TEXT        NOT NULL,
  match_column  TEXT        NOT NULL,
  match_value   TEXT        NOT NULL,
  new_value     TEXT        NOT NULL,
  applied       BOOLEAN     NOT NULL DEFAULT false,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 10. interactions ────────────────────────────────────────────────────────
-- Stores human-feedback events used for few-shot learning.

CREATE TABLE interactions (
  id             SERIAL      PRIMARY KEY,
  workspace_id   INT         NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id      INT         REFERENCES threads(id) ON DELETE SET NULL,
  category_id    INT         REFERENCES categories(id) ON DELETE SET NULL,
  draft_id       INT         REFERENCES drafts(id) ON DELETE SET NULL,
  outcome        TEXT        NOT NULL CHECK (outcome IN ('approved', 'rejected', 'edited')),
  original_body  TEXT,
  final_body     TEXT,
  was_edited     BOOLEAN     NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
