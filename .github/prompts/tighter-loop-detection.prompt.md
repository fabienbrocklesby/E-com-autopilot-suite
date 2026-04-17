---
agent: 'agent'
description: 'Tighten playbook loop detection: per-step limit, pair-loop detection, no-progress detection, lower total step cap'
tools: ['search/codebase', 'edit', 'runCommands', 'mcp_postgres_query', 'mcp_context7', 'mcp_filesystem']
---

# Tighter Loop Detection

The current loop detection (3 same-step fires, 50 total) was a useful safety net but lets too many bad customer-facing actions happen before tripping. Tighten it so a stuck run escalates within 1-2 cycles, not 13.

## Required reading

1. `.github/MCP_DOCTRINE.md` - MCP rules
2. `.github/copilot-instructions.md` - project context
3. `.github/instructions/backend.instructions.md` - Deno conventions
4. `docs/PLAYBOOK_ENGINE.md` - engine architecture
5. `docs/TASK_LOG.md` - recent state, especially the ask_customer fix

## What you're building

Four detection mechanisms in the executor, plus better escalation reasons so the human knows WHY the run was killed.

## Pre-build MCP work

### 1. filesystem - current state

```
filesystem: read api/services/playbook/executor.ts (full)
filesystem: read api/services/playbook/types.ts (look for escalation-related types)
filesystem: list api/services/playbook/handlers/ (which handlers exist)
filesystem: read api/services/playbook/handlers/extract.ts (so you understand context-update detection)
```

Find the existing loop detection code. Note exactly where it sits in `advanceRun` - typically at the top of the function, before step execution.

### 2. postgres - historical loop data

```sql
-- Find runs that hit the existing loop detection
SELECT id, thread_id, status,
       (SELECT COUNT(*) FROM playbook_step_executions WHERE run_id = playbook_runs.id) as exec_count
FROM playbook_runs
WHERE status = 'escalated'
ORDER BY exec_count DESC
LIMIT 10;

-- For the worst offenders, see the actual pattern
SELECT step_id, step_type, status,
       LAG(step_id) OVER (ORDER BY created_at) as prev_step
FROM playbook_step_executions
WHERE run_id = <worst_run_id>
ORDER BY created_at;
```

Look for patterns. Do most loops repeat the same single step? Same pair? Same triple? This informs how aggressive the detection needs to be.

### 3. context7 - relevant docs

Fetch:
- Deno standard library docs for any time/duration utilities you might use
- Postgres `array_agg`, `LAG`, window functions if you'll use them in the SQL queries
- node-postgres / deno-postgres parameterized query patterns

## The 4 detection mechanisms

### Mechanism 1: Per-step fire limit (2, was 3)

The same step_id firing 2 times within the last 5 executions = loop. Customer should never see the same question twice.

```ts
// Inside advanceRun, before executing the next step

const recentExecutions = await query<PlaybookStepExecution>(
  `SELECT step_id, step_type, output, created_at
   FROM playbook_step_executions
   WHERE run_id = $1
   ORDER BY created_at DESC
   LIMIT 10`,
  [runId]
);

// Mechanism 1: per-step limit
const sameStepRecent = recentExecutions
  .slice(0, 5)  // last 5 executions
  .filter(e => e.step_id === currentStepId);

if (sameStepRecent.length >= 2) {
  return await escalateRun(runId, {
    code: "loop_per_step",
    message: `Step '${currentStepId}' fired ${sameStepRecent.length} times in the last 5 executions. Likely stuck.`,
    detail: {
      step_id: currentStepId,
      recent_fires: sameStepRecent.map(e => e.created_at)
    },
  });
}
```

### Mechanism 2: Pair-loop detection

Detect repeating PAIRS of step_ids. Catches alternating loops like `extract → ask → extract → ask`.

```ts
// Mechanism 2: pair loop detection
if (recentExecutions.length >= 4) {
  const lastFour = recentExecutions.slice(0, 4).map(e => e.step_id);
  // If positions [0,1] match [2,3], we have a pair loop
  if (lastFour[0] === lastFour[2] && lastFour[1] === lastFour[3]) {
    return await escalateRun(runId, {
      code: "loop_pair",
      message: `Pair loop detected: '${lastFour[1]}' → '${lastFour[0]}' has repeated. Run is alternating between two steps.`,
      detail: { pattern: [lastFour[1], lastFour[0]] },
    });
  }
}
```

### Mechanism 3: No-progress detection

If the last 3 executions of context-producing steps (`extract`, `find_sheet_row`, `evaluate`) produced no new context variables, we're going through the motions without making progress.

```ts
// Mechanism 3: no-progress detection
const contextProducingSteps = recentExecutions
  .filter(e => ["extract", "find_sheet_row", "evaluate"].includes(e.step_type))
  .slice(0, 3);

if (contextProducingSteps.length === 3) {
  // Check if any of these added new context keys
  const allOutputs = contextProducingSteps.map(e => e.output ?? {});
  const allHadEmptyExtraction = allOutputs.every(out => {
    // For extract: check `extracted_keys` length
    // For find_sheet_row: check if `row_number` was newly set (you may need to compare context before/after)
    // For evaluate: check if it routed somewhere new
    const extracted = out.extracted_keys ?? out.contextUpdates ?? {};
    return Object.keys(extracted).length === 0;
  });

  if (allHadEmptyExtraction) {
    return await escalateRun(runId, {
      code: "no_progress",
      message: "Last 3 context-producing steps added no new information. Conversation is stuck.",
      detail: { recent_steps: contextProducingSteps.map(e => e.step_id) },
    });
  }
}
```

This one is harder to get right because the output shape varies by handler. Read the actual handler outputs you have in the DB to make sure your detection logic matches reality. Adjust as needed.

### Mechanism 4: Total step cap (30, was 50)

Belt-and-braces. Even if all other detections fail, no run should exceed 30 step executions.

```ts
// Mechanism 4: total step cap
const { rows: [{ count }] } = await query<{ count: string }>(
  `SELECT COUNT(*)::text as count
   FROM playbook_step_executions
   WHERE run_id = $1`,
  [runId]
);

if (parseInt(count) >= 30) {
  return await escalateRun(runId, {
    code: "max_executions",
    message: `Run exceeded 30 step executions. Hard safety limit hit.`,
    detail: { execution_count: parseInt(count) },
  });
}
```

## Refactor: structured escalation

Notice all 4 mechanisms call `escalateRun(runId, structuredReason)`. Refactor the existing `escalateRun` (or wherever escalation lives) to accept a structured reason:

```ts
export interface EscalationReason {
  code:
    | "loop_per_step"
    | "loop_pair"
    | "no_progress"
    | "max_executions"
    | "step_failed"
    | "ai_escalated"
    | "manual_rejected";
  message: string;  // human-readable
  detail?: Record<string, unknown>;  // structured context for the UI
}

export async function escalateRun(
  runId: number,
  reason: EscalationReason
): Promise<void> {
  await transaction(async (tx) => {
    // Update the run status
    await tx.queryArray(
      `UPDATE playbook_runs
       SET status = 'escalated',
           updated_at = NOW()
       WHERE id = $1`,
      [runId]
    );

    // Log a synthetic step execution so the UI can show why
    await tx.queryArray(
      `INSERT INTO playbook_step_executions
         (run_id, step_id, step_type, status, output, created_at, completed_at)
       VALUES
         ($1, '_escalation', '_escalation', 'failed', $2, NOW(), NOW())`,
      [runId, JSON.stringify(reason)]
    );

    // Optionally update the linked thread to in_review so it surfaces in the queue
    await tx.queryArray(
      `UPDATE threads
       SET status = 'in_review',
           updated_at = NOW()
       WHERE id = (SELECT thread_id FROM playbook_runs WHERE id = $1)`,
      [runId]
    );
  });
}
```

The synthetic `_escalation` step in the execution log gives the UI a place to show WHY the run died.

## Order of detection in `advanceRun`

Run the detections in order of cheapness. Cheap query first, expensive last. Per-step and pair-loop both use the same `recentExecutions` query so do them together. No-progress also uses it. Total step cap needs a separate count query - do that one last.

```ts
async function advanceRun(runId: number): Promise<void> {
  const run = await loadRun(runId);
  if (!run) return;
  if (run.status !== "running") return;  // only advance running runs

  const currentStepId = run.current_step_id;
  if (!currentStepId) {
    return await escalateRun(runId, {
      code: "no_current_step",
      message: "Run has no current step. Likely corrupted state.",
    });
  }

  // Load recent executions once for all detection mechanisms
  const recentExecutions = await loadRecentExecutions(runId, 10);

  // Mechanism 1: per-step limit
  if (detectPerStepLoop(currentStepId, recentExecutions)) {
    return await escalateRun(runId, perStepLoopReason(currentStepId, recentExecutions));
  }

  // Mechanism 2: pair loop
  if (detectPairLoop(recentExecutions)) {
    return await escalateRun(runId, pairLoopReason(recentExecutions));
  }

  // Mechanism 3: no progress
  if (detectNoProgress(recentExecutions)) {
    return await escalateRun(runId, noProgressReason(recentExecutions));
  }

  // Mechanism 4: total cap (separate query, do last)
  const totalCount = await countExecutions(runId);
  if (totalCount >= 30) {
    return await escalateRun(runId, maxExecutionsReason(totalCount));
  }

  // ... proceed with normal step execution
}
```

Each `detectX` and `XReason` is a small pure function, easy to unit test.

## File structure suggestion

Put the detection logic in a separate file for testability:

```
api/services/playbook/loop_detection.ts
```

Exports:
- `detectPerStepLoop`
- `detectPairLoop`
- `detectNoProgress`
- `perStepLoopReason`, `pairLoopReason`, `noProgressReason`, `maxExecutionsReason`
- `EscalationReason` type

The executor imports and uses these. Smaller files, easier to read, easier to test.

## Verification

### 1. Type and lint checks

```bash
cd api && deno check services/playbook/executor.ts services/playbook/loop_detection.ts
```

### 2. Manually craft a loop scenario

Create a test playbook designed to loop (intentionally):

```sql
INSERT INTO playbooks (workspace_id, category_id, name, plain_language_description, steps, version, is_active)
VALUES (1, 1, 'Loop Test', 'Test playbook for loop detection', '[
  {"id": "step_a", "type": "extract", "config": {"variables": ["impossible_var"]}},
  {"id": "step_b", "type": "branch", "config": {"condition": "context.impossible_var != null", "if_true": "complete_1", "if_false": "step_a"}},
  {"id": "complete_1", "type": "complete"}
]'::jsonb, 1, true);
```

Then trigger a run on this playbook and verify it escalates within 2-3 cycles, not 13+.

### 3. Verify each mechanism trips

Build 4 minimal scenarios, one per mechanism:

- **Per-step**: a self-looping step (like above)
- **Pair**: two steps that ping-pong
- **No-progress**: extracts that never find new variables
- **Max executions**: a long playbook that legitimately runs 30+ steps (shouldn't exist in practice but confirm the safety net)

For each, verify in postgres that the escalation reason recorded in `_escalation` step output has the correct `code`.

### 4. Verify the existing-failing-run scenario would have been caught earlier

Take the original failing run #4. Walk the executions in order. At which execution would each mechanism have tripped?

- Per-step: ask_1 fires twice → tripped at execution ~6 (was 13)
- Pair-loop: extract→ask repeats → tripped at execution ~6 too
- No-progress: extracts produce no new vars after first 2 → tripped at execution ~5

Document this in TASK_LOG so you have proof the new detection is sufficient.

### 5. Verify legitimate playbooks don't false-positive

Run the refund playbook through a real test email. Confirm it completes normally (~9 step executions) without tripping any detection.

Also: build a deliberately long-but-legitimate playbook (15+ legitimate steps) and confirm it completes.

### 6. Postgres state for thread routing

After an escalation, verify:
- Run status = `escalated`
- A synthetic `_escalation` execution was inserted with the correct reason code
- The linked thread status is `in_review` (so it shows in the review queue)

```sql
SELECT r.id, r.status as run_status, t.status as thread_status,
       (SELECT jsonb_pretty(output) FROM playbook_step_executions
        WHERE run_id = r.id AND step_id = '_escalation') as escalation_reason
FROM playbook_runs r
JOIN threads t ON t.id = r.thread_id
WHERE r.id = <test_run_id>;
```

## Surface escalation reason in the UI

Optional but recommended: in the thread detail page's playbook run section, if the run is escalated, show the escalation reason from the `_escalation` step. Just a styled note: "This run was escalated: [message]" with the code as a small label.

If you do this, use the playwright MCP to verify it renders correctly. If skipping, note in TASK_LOG that the UI piece is deferred.

## Done criteria

- [ ] Loop detection refactored into `api/services/playbook/loop_detection.ts`
- [ ] All 4 mechanisms implemented: per-step (2), pair, no-progress, max (30)
- [ ] `escalateRun` accepts structured `EscalationReason` and logs synthetic `_escalation` step
- [ ] Linked thread set to `in_review` on escalation
- [ ] All 4 mechanisms verified to trip in test scenarios
- [ ] Original failing run scenario verified to escalate within 2-3 cycles
- [ ] Legitimate refund playbook verified to complete normally without false positives
- [ ] Postgres queries confirm escalation reasons are recorded
- [ ] (Optional) UI shows escalation reason on thread page
- [ ] All TypeScript checks pass
- [ ] TASK_LOG updated with MCP usage trace
- [ ] Commit message: `feat(playbook): tighter loop detection with structured escalation reasons`

## What NOT to do

- Don't change handler return types
- Don't change the playbook step config schema
- Don't touch the parser
- Don't introduce a job queue or background worker for this (keep detection inline in advanceRun)
- Don't add metrics/observability libraries
