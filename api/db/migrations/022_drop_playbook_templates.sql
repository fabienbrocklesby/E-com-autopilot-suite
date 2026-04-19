-- 022_drop_playbook_templates.sql
-- Why this exists: The template library feature has been removed from the product.
--   The playbook_templates table, its indexes, and all seed data are no longer needed.
-- Touches tables: playbook_templates
-- Destructive: yes — drops the table and its 15 seed rows

BEGIN;

DROP TABLE IF EXISTS playbook_templates;

COMMIT;
