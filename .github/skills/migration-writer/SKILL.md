---
name: migration-writer
description: How to write a Postgres migration for this project. Use when adding tables, columns, indexes, or constraints. Covers conventions, idempotency, destructive change handling, and validation.
---

# Migration Writer Skill

## File location and naming

- Path: `api/db/migrations/`
- Format: `0NN_short_snake_case_description.sql`
- N is sequential, three digits, zero-padded
- Find the next number: `ls api/db/migrations/ | tail -1` then increment

## Template

```sql
-- 0NN_what_this_does.sql
-- Why this exists: <one paragraph>
-- Touches tables: <list>
-- Destructive: <yes/no, what data is affected>

BEGIN;

-- Your DDL here

COMMIT;
```

## Conventions (non-negotiable)

1. **Wrap in `BEGIN; ... COMMIT;`** - partial failures don't leave broken state
2. **Use `IF NOT EXISTS`** on CREATE TABLE, CREATE INDEX
3. **Foreign keys: explicit `ON DELETE`** - never default
4. **Workspace scoping**: every workspace-owned table has `workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`
5. **Timestamps**: `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` and `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
6. **Updated_at trigger**: `CREATE TRIGGER trg_<table>_updated_at BEFORE UPDATE ON <table> FOR EACH ROW EXECUTE FUNCTION set_updated_at();`
7. **Enums**: `TEXT CHECK (col IN ('a', 'b'))` - never Postgres ENUM
8. **JSONB over JSON**, always
9. **Index FKs** unless table is tiny

## Standard table template

```sql
CREATE TABLE IF NOT EXISTS new_table (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- domain columns
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'archived')),
  config JSONB NOT NULL DEFAULT '{}',
  -- timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_new_table_workspace ON new_table(workspace_id);
CREATE INDEX IF NOT EXISTS idx_new_table_status ON new_table(workspace_id, status);

CREATE TRIGGER trg_new_table_updated_at
  BEFORE UPDATE ON new_table
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

## Adding a column

```sql
BEGIN;

ALTER TABLE existing_table
  ADD COLUMN IF NOT EXISTS new_column TEXT;

-- If the column should be NOT NULL eventually:
-- 1. Add as nullable first
-- 2. Backfill in this same migration
-- 3. Then add NOT NULL constraint

UPDATE existing_table SET new_column = 'default' WHERE new_column IS NULL;

ALTER TABLE existing_table
  ALTER COLUMN new_column SET NOT NULL;

COMMIT;
```

## Destructive changes

If you're dropping a column, table, or constraint, or changing a type:

1. **Document at the top** of the migration what data is affected
2. **Preserve data first** if it should be transformed:
   ```sql
   -- Move data to new column before dropping old
   UPDATE table SET new_col = old_col WHERE new_col IS NULL;
   ALTER TABLE table DROP COLUMN old_col;
   ```
3. **For multi-step destructive migrations**, consider splitting into two migrations across deploys:
   - Migration A: add new column, backfill, deploy code that uses new
   - Migration B (later deploy): drop old column

## Renaming

Postgres supports rename in place but be careful with:
- Application code that references the old name (deploy code change first or in same release)
- Indexes with names tied to the old column name
- Triggers

```sql
ALTER TABLE my_table RENAME COLUMN old_name TO new_name;
```

## Indexes

```sql
-- Single column
CREATE INDEX IF NOT EXISTS idx_table_col ON table(col);

-- Composite (most selective first)
CREATE INDEX IF NOT EXISTS idx_table_a_b ON table(a, b);

-- Partial (when you only query a subset)
CREATE INDEX IF NOT EXISTS idx_table_active ON table(workspace_id) WHERE status = 'active';

-- Unique
CREATE UNIQUE INDEX IF NOT EXISTS uq_table_a_b ON table(a, b);

-- For JSONB
CREATE INDEX IF NOT EXISTS idx_table_config_key ON table USING gin(config);
-- Or for a specific path:
CREATE INDEX IF NOT EXISTS idx_table_config_status ON table((config->>'status'));
```

## After writing the migration

1. **Run it locally**: `make db-migrate` (or whatever the command is)
2. **Verify with Postgres MCP**:
   ```sql
   \d table_name
   SELECT * FROM schema_migrations WHERE filename = '0NN_...';
   ```
3. **Test rollback** if the migration is risky - `BEGIN; <migration>; ROLLBACK;` to verify it doesn't leave artifacts
4. **Document** in `docs/TASK_LOG.md`
5. **Commit message**: `db: <description from migration filename>`

## What not to do

- Don't put stored procedures in migrations (logic lives in Deno)
- Don't put triggers with business logic in migrations (only utility triggers like updated_at)
- Don't use Postgres-specific features without checking they're supported in production version (we're on 16)
- Don't create views unless documented and necessary
- Don't edit a migration that has been applied
