# Verify: Evaluate → Ask Customer → Resume Cycle

## Context

You are working on a Deno + Hono + SvelteKit 5 email automation dashboard.
The playbook engine processes emails through multi-step AI workflows.

Use the **filesystem MCP** to read all files referenced below.
Use the **postgres MCP** to inspect run and execution records.
Use **context7** to look up Deno/TypeScript APIs if needed.
Use **playwright** to test the thread UI if the fix produces visible UI changes.
Use the **svelte MCP** if you touch any SvelteKit 5 frontend component.

---

## Background

A playbook run failed because `evaluate` routed `missing variable → escalate`
instead of `missing variable → ask_customer`. That design guide issue is being
fixed in a separate prompt. This prompt covers the execution layer.

The correct intended flow for "ask if missing" playbooks is:

```
Email arrives → extract (order_number = null) → evaluate (missing → ask_customer)
→ ask_customer PAUSES run (waiting_for_customer)
→ Customer replies with order number
→ Run RESUMES from ask_customer step
→ ask_customer handler advances to next step
→ extract again (or direct send_reply) → send_reply → complete
```

Before shipping this to production, verify that the execution layer handles
this cycle correctly and that loop detection does not fire incorrectly.

---

## Step 1 — Read the executor and handler code

Use the filesystem MCP to read:
- `api/services/playbook/executor.ts` — step dispatch loop, loop detection
- `api/services/playbook/handlers/evaluate.ts` — routing logic
- `api/services/playbook/handlers/ask_customer.ts` — pause and resume logic
- `api/services/playbook/types.ts` — StepDecision, RunContext types
- `api/services/playbook/registry.ts` — step type → handler mapping

---

## Step 2 — Verify evaluate handler routing

In `evaluate.ts`, confirm:

1. The handler supports `advance_to` decisions that can point to ANY step ID,
   including `ask_customer` steps.
2. The `on_false` and `on_unsure` routing fields in the evaluate step config
   can reference a step ID that is NOT escalate.
3. When the evaluate condition is false (variable missing), the decision
   returned is `{ type: "advance_to", step_id: config.on_false }` (or equivalent).
   It must NOT hard-code escalate as the fallback.

If any of these are broken, fix them. Document what you changed and why.

---

## Step 3 — Verify ask_customer pause and resume

In `ask_customer.ts`, confirm:

1. On first execution (no customer reply yet), the handler:
   - Sends the question to the customer (or enqueues it)
   - Returns a decision that sets run status to `waiting_for_customer`
   - Does NOT advance to the next step yet

2. On resume (run is `waiting_for_customer`, customer has replied):
   - The executor correctly routes the new inbound email to the waiting run
   - The ask_customer handler processes the reply
   - Returns `advance` (move to next step in array) so execution continues

3. The step immediately after `ask_customer` in the step array is the one
   that runs after the customer replies. Confirm this is how the executor works.

If anything is wrong, fix it.

---

## Step 4 — Verify loop detection does not fire on this cycle

The loop detection in `executor.ts` includes:
- Per-step limit: same step fires twice within last 5 executions → escalate
- Pair-loop: same A→B pattern repeating → escalate
- No-progress: 3 consecutive context-producing steps with no new variables → escalate

For the "ask if missing" cycle, the execution sequence is:
```
extract_1 → evaluate_1 → ask_1 (pause)
[customer replies]
ask_1 (resume, advances) → extract_2 → send_reply_1 → complete_1
```

Verify that:
1. `ask_1` firing twice (once to pause, once to resume/advance) does NOT trigger
   the per-step loop detection. These are two different execution phases of the
   same step, not a loop. If the current logic would incorrectly escalate here,
   fix it. The per-step counter should only count completions that advance the
   cursor, not the initial pause.
2. The `evaluate → ask_customer` pair does NOT appear twice in the execution
   history (it only fires once going in, then ask_customer resumes and advances
   past evaluate). Confirm no pair-loop fires.
3. `extract_1` (order_number = null) followed by `extract_2` (order_number = populated)
   does NOT trigger the no-progress detection. The second extract produces a new
   variable. Confirm this.

Use the postgres MCP to check a real failed run's execution history:
```sql
SELECT
  pse.step_id,
  pse.step_type,
  pse.status,
  pse.input,
  pse.output,
  pse.created_at
FROM playbook_step_executions pse
JOIN playbook_runs pr ON pr.id = pse.run_id
WHERE pr.status IN ('failed', 'escalated')
ORDER BY pse.created_at DESC
LIMIT 20;
```

If the current run data shows loop detection firing incorrectly for this pattern,
fix the loop detection logic in `executor.ts`.

---

## Step 5 — Integration smoke test via playwright

Once the code is verified/fixed:

1. Use playwright to navigate to the thread page for the failed run.
2. Confirm the UI shows the run state correctly (escalated/failed).
3. There is no automated way to re-run — just verify the UI renders without errors
   and the step execution history is visible.

If the playwright test finds a UI rendering error on the thread page related to
run status display, fix it in the relevant SvelteKit 5 component (runes only —
`$state`, `$derived`, `$effect`, `$props` — no Svelte 4 syntax).

---

## Constraints

- Do not change how `find_sheet_row`, `send_reply`, or `complete` work.
- Do not add new step types.
- All DB writes in `transaction()` from `db/client.ts`.
- Every workspace-owned query must filter by `workspace_id`.
- Routes stay thin — logic in services.
- SvelteKit 5 runes only if you touch frontend. No `$:`, no `export let`, no `onMount`.
- Throw `AppError(message, status)` for known errors in backend code.

---

## Definition of done

- `evaluate.ts` correctly routes `on_false`/`on_unsure` to any step ID,
  not hardcoded to escalate.
- `ask_customer.ts` correctly pauses on first fire and advances on resume.
- Loop detection in `executor.ts` does not fire on the evaluate → ask → resume
  → reply cycle.
- Postgres query confirms no spurious loop-detection escalations exist for
  runs that were simply waiting for customer info.
- Playwright confirms the thread page renders without errors.
