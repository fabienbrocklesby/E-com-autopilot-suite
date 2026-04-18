-- 021_playbook_source_of_truth.sql
-- Why this exists: Playbooks become the source of truth for how categorised emails
--   are handled. Reply behaviour (writing style, reply mode, confidence threshold)
--   moves from categories to playbooks. Categories are now pure classification labels.
--   Also adds per-step require_approval support (stored in step JSONB, no schema change)
--   and drops the dead migrated_to_flows column.
-- Touches tables: playbooks (add columns), categories (drop columns)
-- Destructive: yes - drops allow_auto_reply, confidence_threshold, writing_style,
--   migrated_to_flows from categories. All current data is disposable (dummy data).

BEGIN;

ALTER TABLE playbooks
  ADD COLUMN IF NOT EXISTS writing_style TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reply_mode TEXT NOT NULL DEFAULT 'draft_only'
    CHECK (reply_mode IN ('auto_reply', 'draft_only')),
  ADD COLUMN IF NOT EXISTS confidence_threshold NUMERIC(4,3) NOT NULL DEFAULT 0.800
    CHECK (confidence_threshold >= 0 AND confidence_threshold <= 1);

ALTER TABLE categories
  DROP COLUMN IF EXISTS allow_auto_reply,
  DROP COLUMN IF EXISTS confidence_threshold,
  DROP COLUMN IF EXISTS writing_style,
  DROP COLUMN IF EXISTS migrated_to_flows;

COMMIT;
