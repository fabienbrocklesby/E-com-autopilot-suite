-- 024_playbook_unique_per_category.sql
-- Why this exists: Enforce max one playbook per category. The version-bumping
-- pattern created the illusion of "v2", "v5" etc. which was confusing. Playbooks
-- are now simply "the playbook for a category" — no versioning concept in UI or
-- creation flow. The partial unique index covers only non-null category_id so
-- unlinked/orphan playbooks are still allowed during transitions.
-- Touches tables: playbooks
-- Destructive: no — only adds a constraint. Safe if no category already has
-- multiple playbooks (verify before running on prod).

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_playbooks_unique_category
  ON playbooks(category_id)
  WHERE category_id IS NOT NULL;

COMMIT;
