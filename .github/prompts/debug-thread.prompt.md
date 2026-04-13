---
agent: 'agent'
description: 'Investigate why a specific thread did or did not behave as expected'
tools: ['search/codebase', 'mcp_postgres_query']
---

# Debug a thread

Thread ID: ${input:threadId:Thread ID to investigate}
Symptom: ${input:symptom:What seems wrong (e.g. "didn't auto-reply", "wrong category", "stuck in review")}

## Steps

1. **Use Postgres MCP** to gather state:
   ```sql
   SELECT * FROM threads WHERE id = ${input:threadId};
   SELECT * FROM messages WHERE thread_id = ${input:threadId} ORDER BY received_at;
   SELECT * FROM drafts WHERE thread_id = ${input:threadId} ORDER BY created_at;
   SELECT c.* FROM categories c JOIN threads t ON t.category_id = c.id WHERE t.id = ${input:threadId};
   SELECT * FROM playbook_runs WHERE thread_id = ${input:threadId};
   SELECT * FROM playbook_step_executions WHERE run_id IN (SELECT id FROM playbook_runs WHERE thread_id = ${input:threadId}) ORDER BY created_at;
   SELECT * FROM sheet_rule_executions WHERE thread_id = ${input:threadId};
   ```

2. **Walk through the expected flow**:
   - What category should it be in?
   - Should auto-reply have fired? Check category settings + confidence threshold + global threshold.
   - If a playbook run exists, what step is it on? What was the last execution result?

3. **Compare expected vs actual**. State the gap clearly.

4. **Check for known bugs** from `.github/copilot-instructions.md` "Known issues" section. Is this one of them?

5. **Propose**:
   - Immediate fix for this thread (e.g. manually advance the playbook run, manually re-categorise, manually send)
   - Root cause if it's a bug
   - Whether the fix should be a code change or a config change

6. **If code change needed**, propose the diff. Don't apply without confirmation.

7. **If config change**, propose the SQL or UI change to make.
