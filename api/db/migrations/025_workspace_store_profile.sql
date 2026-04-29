-- 025_workspace_store_profile.sql
-- Adds store profile fields to workspaces so the AI has business context.
-- Touches tables: workspaces
-- Destructive: no

BEGIN;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS store_name TEXT,
  ADD COLUMN IF NOT EXISTS store_description TEXT,
  ADD COLUMN IF NOT EXISTS store_url TEXT;

COMMIT;
