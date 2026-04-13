---
agent: 'agent'
description: 'Write a new Postgres migration following project conventions'
tools: ['search/codebase', 'edit', 'mcp_postgres_query']
---

# Write a new migration

What it does: ${input:purpose:Brief description of what this migration changes}

## Steps

1. **Check existing migrations** in `api/db/migrations/` to find the next sequential number.

2. **Use Postgres MCP** to inspect the current schema for any tables you'll be touching. Don't guess column names or types.

3. **Create the file** at `api/db/migrations/0NN_short_description.sql` following the conventions in `.github/instructions/sql.instructions.md`:
   - Wrap in `BEGIN; ... COMMIT;`
   - Use `IF NOT EXISTS` for creates
   - Foreign keys with explicit ON DELETE behaviour
   - Workspace scoping where applicable
   - Timestamps + trigger
   - JSONB over JSON
   - Index foreign keys

4. **If destructive** (drops, type changes), include a comment block explaining what data is affected and how it's preserved/transformed.

5. **Test in dev**:
   - Run `make db-migrate` (or whatever the project's migration command is)
   - Use Postgres MCP to verify the schema is what you expect
   - If destructive, verify data is preserved correctly

6. **Update `TASK_LOG.md`** with the migration number and what it does.

7. **Suggest the commit message**: `db: ${input:purpose}`
