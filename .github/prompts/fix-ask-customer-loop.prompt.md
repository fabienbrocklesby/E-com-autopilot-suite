---
agent: 'agent'
description: 'CRITICAL: fix the ask_customer skip routing bug that causes infinite loops in playbook runs'
tools: ['search/codebase', 'edit', 'runCommands', 'mcp_postgres_query', 'mcp_context7', 'mcp_filesystem', 'mcp_playwright']
---

# Fix: ask_customer Skip Routing Bug

This is a precision fix. The bug is diagnosed, the cause is known, the fix is small. The work is in doing it carefully and verifying it actually solves the demo case.

## Required reading before any edits

Read these in order:

1. `.github/MCP_DOCTRINE.md` — the rules for how you use MCP servers in this task. Non-negotiable.
2. `.github/copilot-instructions.md` — project context
3. `docs/TASK_LOG.md` — what's been done, especially the recent diagnosis entry
4. `skills/ai-driven-step/SKILL.md` — the pattern ask_customer should follow

## The bug

When `ask_customer`'s deterministic pre-check finds that all `required_context` variables are already present, the handler returns `{ action: "advance_to", stepId: on_reply_goto }`. This routes BACKWARD to wherever `on_reply_goto` points, because that field is "where to resume after the customer replies."

When we're skipping the ask entirely (because we don't need to ask), we should `advance` sequentially to the next step, not loop back to a step that re-runs extraction.

The same bug applies to the AI's `skip` action path inside the handler.

## Pre-fix MCP work (do this in order)

### 1. Filesystem awareness

List the relevant directories to see what you're working with:

```
filesystem: list api/services/playbook/
filesystem: list api/services/playbook/handlers/
filesystem: read api/services/playbook/handlers/ask_customer.ts (full file)
filesystem: read api/services/playbook/handlers/evaluate.ts (for comparison)
filesystem: read api/services/playbook/executor.ts (to understand how decisions are applied)
filesystem: read api/services/playbook/types.ts (for the StepDecision type)
```

Confirm: where in `ask_customer.ts` is the deterministic pre-check? Where is the AI skip path? What's the exact return shape?

### 2. Postgres state of the failing run

Document the bad state for the after-comparison:

```sql
-- The escalated run that demonstrates the bug
SELECT id, playbook_id, playbook_version, status, jsonb_pretty(context)
FROM playbook_runs
WHERE id = 4;

-- The execution log showing the loop
SELECT step_id, step_type, status, jsonb_pretty(output)
FROM playbook_step_executions
WHERE run_id = 4
ORDER BY created_at;

-- Count of executions to confirm the loop
SELECT step_id, COUNT(*) as fire_count
FROM playbook_step_executions
WHERE run_id = 4
GROUP BY step_id
ORDER BY fire_count DESC;
```

Save the output. You'll compare against this after the fix.

### 3. Verify the playbook structure

```sql
SELECT id, name, version, jsonb_pretty(steps)
FROM playbooks
WHERE id = 6;
```

Confirm the step order matches what we diagnosed:
- index 0: extract_1
- index 1: branch_1
- index 2: find_1
- index 3: ask_1 (where the loop traps)
- index 4: evaluate_1 (never reached)
- index 5+: update_1, approval_1, send_1, complete_1, escalate_1

Note the `ask_1.config.on_reply_goto` value. It should be `"extract_1"`.

### 4. Type safety check

Read `api/services/playbook/types.ts`. Find the `StepDecision` type. Confirm the union members:
- `{ action: "advance" }` (sequential next)
- `{ action: "advance_to", stepId: string }` (named jump)
- `{ action: "pause", reason: ..., resumeStepId: string }` (await event)
- `{ action: "complete" }` (terminal success)
- `{ action: "fail", error: string }` (terminal failure)

Verify the discriminator and field names match what the executor expects. Read the executor's decision-handling code if there's any ambiguity.

## The fix

In `api/services/playbook/handlers/ask_customer.ts`:

### Change 1: Deterministic pre-check skip

Find the block that handles "all required_context already present, no need to ask". Currently it returns:

```ts
return {
  decision: { action: "advance_to", stepId: on_reply_goto },
  output: { action: "skipped", reason: "all required context present" },
};
```

Change to:

```ts
return {
  decision: { action: "advance" },
  output: { 
    action: "skipped", 
    reason: "all required context present", 
    skipped_message_send: true 
  },
};
```

### Change 2: AI skip action

Find the block that handles the AI returning `{ action: "skip", extracted: {...} }`. Currently it returns:

```ts
return {
  decision: { action: "advance_to", stepId: on_reply_goto },
  contextUpdates: parsed.extracted ?? {},
  output: { action: "skipped", reasoning: parsed.reasoning },
  aiCalls: [...],
};
```

Change to:

```ts
return {
  decision: { action: "advance" },
  contextUpdates: parsed.extracted ?? {},
  output: { 
    action: "skipped", 
    reasoning: parsed.reasoning,
    extracted_keys: Object.keys(parsed.extracted ?? {}),
  },
  aiCalls: [...],
};
```

### Change 3: Add inline doc comment

Above the deterministic pre-check, add:

```ts
// Routing semantics:
//   - on_reply_goto: where to resume AFTER a customer reply triggers re-execution.
//     Used only when this step actually paused for a customer reply.
//   - "advance": sequential next step. Used when this step did its job and
//     downstream steps should run.
//
// When required_context is already present, we are skipping the ask entirely.
// We did not pause, no customer reply is pending, so on_reply_goto is irrelevant.
// We must advance sequentially so that downstream steps (evaluate, etc.) execute.
```

This comment is critical. It prevents the next person (or AI) from "fixing" this back to the broken behaviour.

### Do NOT change

- The AI ask path (`{action: "ask", message: "..."}`) — that correctly returns `pause('waiting_for_customer', resumeStepId: step.id)`
- The AI escalate path (`{action: "escalate", reason: "..."}`) — that correctly returns `fail`
- The `on_reply_goto` field itself or how it's stored in config — semantics are correct, only the wrong path was using it
- The legacy `{message}` backward-compat path — leave it alone unless it has the same bug (check it)

### Check the legacy path

While you're in the file, check the legacy `{message}` backward-compat branch. Does it also have the wrong skip return? If yes, apply the same fix there.

## Verification (mandatory, in this order)

### Verification 1: TypeScript compiles

```bash
cd api && deno check services/playbook/handlers/ask_customer.ts
```

Zero errors expected. If there are type errors, you got the StepDecision shape wrong. Re-read `types.ts` and fix.

### Verification 2: Reset and replay the failing scenario

The escalated run on the demo thread is dead — leave it for the historical record. But the playbook is still good.

Send a fresh test email to the workspace's connected Gmail. Subject: "Refund please". Body: "Hey, I need a refund for the radiator I bought, it's broken. Cheers, Fabien"

Wait 30 seconds for the webhook to fire and the run to start.

### Verification 3: Inspect the new run via postgres

```sql
-- Find the new run
SELECT id, playbook_id, playbook_version, status, current_step_id, jsonb_pretty(context)
FROM playbook_runs
WHERE thread_id = (SELECT MAX(id) FROM threads WHERE workspace_id = 1)
ORDER BY created_at DESC
LIMIT 1;

-- Inspect its execution log
SELECT step_id, step_type, status, 
       jsonb_pretty(input) as input, 
       jsonb_pretty(output) as output
FROM playbook_step_executions
WHERE run_id = <new_run_id>
ORDER BY created_at;
```

**Expected sequence (write this down before running, compare against actual):**

1. `extract_1` — success, advances to next
2. `branch_1` — success, advance_to find_1
3. `find_1` — success, sets `row_number=2`, advances sequentially
4. `ask_1` — success, action: "skipped" because customer_name and product_name (or whatever required_context is) are already in context, advances sequentially **to evaluate_1, NOT back to extract_1**
5. `evaluate_1` — success, advance_to update_1 (because row_number is set)
6. `update_1` — success, sheet row updated to "Refund Requested"
7. `approval_1` — pause, status becomes `waiting_for_human`

The run should be in `waiting_for_human` status when this completes. Total step executions: 7 or 8, NOT 50.

If the actual sequence diverges from expected, the fix isn't done. Diagnose and iterate.

### Verification 4: Sheet state via postgres

The dev DB stores Google Sheets API responses indirectly. Check the `sheet_columns` and any audit log for the actual write:

```sql
-- Look for evidence of the sheet write happening
SELECT * FROM playbook_step_executions 
WHERE run_id = <new_run_id> AND step_type = 'update_sheet';

-- Inspect the output to confirm what was written
```

If you have direct sheet API access in dev, also verify in the actual Google Sheet that row 2's Status column changed.

### Verification 5: Manual approval via API

Since the manual action banner (Phase 5.5 Task 5) isn't built yet, approve via curl:

```bash
# Get the run id from verification 3
curl -X POST http://localhost:8000/playbook-runs/<run_id>/approve \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"input": "test_txn_abc, $460"}'
```

### Verification 6: Continue and complete

After approval, the run should advance through `update_2`, `send_1`, `complete_1`. Wait 10 seconds, then re-query:

```sql
SELECT id, status, current_step_id, jsonb_pretty(context)
FROM playbook_runs WHERE id = <run_id>;

SELECT step_id, step_type, status, jsonb_pretty(output)
FROM playbook_step_executions
WHERE run_id = <run_id> AND created_at > NOW() - INTERVAL '1 minute'
ORDER BY created_at;
```

Expected:
- Run status = `complete`
- Context has `refund_notes` = "test_txn_abc, $460"
- send_1 output shows the AI-drafted message that was sent
- A new outbound message appears in the thread

### Verification 7: Customer-facing message quality

Read the actual outbound message. It should:
- Reference the refund amount ($460) naturally
- Address the customer by name
- Match a casual NZ tone
- Not sound robotic
- Not start with "Thank you for your inquiry" or similar boilerplate

If the message is robotic, that's a separate issue (send_reply prompt quality), not this fix. Note it in TASK_LOG but don't address here.

### Verification 8: Playwright dashboard check

Drive the dashboard via playwright:

1. Navigate to `/threads/<thread_id>` for the test thread
2. Verify the messages are displayed including the AI-drafted reply
3. Verify the playbook run section shows complete status
4. Take a screenshot for the TASK_LOG

## context7 docs to fetch

Even though this is a small fix, fetch:

- **Deno** docs for the `deno check` command and any module resolution specifics relevant to your edit
- **node-postgres** or whatever your DB driver is, for the `transaction` API used elsewhere in the codebase (so you understand the existing patterns even if you don't change them)

You probably won't need to fetch much for this fix specifically, but follow the doctrine: don't write or change code based on memory.

## TASK_LOG entry

Add to `docs/TASK_LOG.md`:

```markdown
## YYYY-MM-DD — Fix: ask_customer skip routing bug

**Phase**: 5.5 (urgent fix)
**Status**: complete

### What was done
- Fixed `api/services/playbook/handlers/ask_customer.ts` deterministic pre-check 
  to return `{action: "advance"}` instead of `{action: "advance_to", stepId: on_reply_goto}`
- Same fix applied to AI "skip" action path
- Same fix applied to legacy `{message}` path (if it had the same bug)
- Added inline documentation explaining routing semantics

### Bug origin
`on_reply_goto` config field was being used as the skip destination. Semantically 
`on_reply_goto` is "resume here AFTER a customer reply" — only relevant when the 
step paused. When skipping the ask entirely (no pause, no reply pending), the 
correct behaviour is sequential advance.

### Verification
- New test thread: <thread_id>
- New run: <run_id>
- Execution sequence observed: extract_1 → branch_1 → find_1 → ask_1 (skipped) → 
  evaluate_1 → update_1 → approval_1 (paused) → [manual approve] → update_2 → 
  send_1 → complete_1
- Total executions: 9 (was 50+ before fix, escalated by safety net)
- Sheet row 2 Status updated to "Refund Requested" then "Refunded"
- Customer received contextual reply mentioning $460 amount
- Postgres queries confirming state: <inline or linked>
- Playwright screenshot: <path>

### MCP usage trace
- filesystem: read ask_customer.ts, evaluate.ts, executor.ts, types.ts to 
  understand the StepDecision contract
- postgres: 6 queries — initial bad state, post-fix run inspection, 
  context bag verification, completion confirmation
- context7: Deno check command syntax
- playwright: drove dashboard, verified thread detail page, screenshot saved

### Decisions made
- Fixed both deterministic and AI skip paths in one commit (related, atomic)
- Did NOT touch on_reply_goto field semantics — they're correct, only the 
  wrong code path was using them
- Did NOT regenerate the playbook — existing Refund v2 playbook works correctly 
  with the fixed handler

### Open questions
- send_reply message quality is acceptable but could be sharper. Track for 
  later prompt tuning.
- Manual action banner UI not yet built — approval still requires curl. 
  See phase-5-5-task-5 prompt.

### Next
- Run /phase-5-5-task-5-banner to build the manual action banner
- Run /phase-5-5-task-4-loop-detection for tighter loop detection
```

## Done criteria

- [ ] Fix applied to all three skip paths in ask_customer.ts (deterministic, AI, legacy)
- [ ] Inline routing semantics comment added
- [ ] TypeScript compiles with zero errors
- [ ] New test run completes successfully without looping (ideally <10 step executions)
- [ ] Sheet row updated correctly twice (Refund Requested, then Refunded)
- [ ] AI-drafted reply sent and references the amount
- [ ] Playwright screenshot saved
- [ ] TASK_LOG entry added with full MCP usage trace
- [ ] Commit message: `fix(playbook): ask_customer skip should advance sequentially not loop to on_reply_goto`

## What NOT to do in this commit

- Don't touch other handlers
- Don't change the parser
- Don't change find_sheet_row
- Don't build the manual action banner (separate prompt)
- Don't tighten loop detection (separate prompt)
- Don't regenerate the playbook (it's already correct)
- Don't refactor unrelated code "while you're here"
