---
applyTo: "**/*.sql"
---

# SQL conventions

## Migrations are append-only

- New file: `api/db/migrations/00N_short_description.sql` where N is the next sequential number
- Never edit a migration that has been applied (check `schema_migrations` table)
- Migrations run in filename order via `api/db/migrate.ts`

## Migration template

```sql
-- 00N_what_this_does.sql
-- Brief description of why this migration exists.

BEGIN;

CREATE TABLE IF NOT EXISTS new_table (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- columns
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_new_table_workspace ON new_table(workspace_id);

-- Trigger for updated_at
CREATE TRIGGER trg_new_table_updated_at
  BEFORE UPDATE ON new_table
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
```

## Conventions

- **Always wrap in `BEGIN; ... COMMIT;`** so partial failures don't leave half-applied state.
- **Use `IF NOT EXISTS`** for `CREATE TABLE`, `CREATE INDEX`. Idempotency matters.
- **Foreign keys ON DELETE behaviour must be explicit.** Pick `CASCADE`, `SET NULL`, or `RESTRICT` - never default.
- **Workspace scoping**: every workspace-owned table has `workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`.
- **Timestamps**: `created_at` and `updated_at` are `TIMESTAMPTZ NOT NULL DEFAULT NOW()`. Add the `set_updated_at` trigger.
- **Enums**: use `TEXT CHECK (col IN ('a', 'b', 'c'))` instead of Postgres `ENUM` - easier to evolve.
- **JSONB over JSON.** Always.
- **Index foreign keys** unless the table is tiny (<1000 rows expected).

## Destructive changes

If a migration drops a column, drops a table, or changes a column type in a non-trivial way:

1. Add a comment explaining what data is being lost / transformed
2. If production data exists, include the data migration step in the same file (UPDATE before DROP)
3. Flag it in `docs/TASK_LOG.md` as a destructive migration

## Things to avoid

- Don't add a trigger function inline in a migration. Define it in the schema base and reuse.
- Don't add stored procedures. Logic lives in the Deno backend.
- Don't add views unless they're for a specific reporting use case and documented.
