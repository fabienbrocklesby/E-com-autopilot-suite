---
agent: 'agent'
description: 'Phase 2: build the playbook engine alongside the existing flow'
tools: ['search/codebase', 'edit', 'runCommands', 'mcp_postgres_query']
---

# Phase 2: Playbook Engine Foundation

Goal: Build the playbook execution engine as a **new path alongside** the existing `categoriseAndDraft` flow. Categories without a playbook keep the old behaviour. Categories with a playbook use the engine. This is strangler-fig migration.

## Required reading

- `docs/PLAYBOOK_ENGINE.md` - the architecture spec. Read it ALL.
- `docs/TASK_LOG.md` - confirm Phase 1 done
- `api/services/categorisation.ts` - the legacy flow we're paralleling

## Scope of this phase

We are building the engine and the data model. We are NOT building the UI yet (Phase 3) and NOT migrating existing categories (Phase 4).

By end of phase: a hardcoded playbook (the tracking-request one from `PLAYBOOK_ENGINE.md`) runs end-to-end against a real thread in dev, advancing through steps, persisting state, sending a real reply.

## Tasks

### 1. Migrations

Create migrations:

**`010_playbooks.sql`**:
```sql
CREATE TABLE playbooks (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category_id INT REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  plain_language_description TEXT,
  steps JSONB NOT NULL DEFAULT '[]',
  version INT NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_playbooks_workspace ON playbooks(workspace_id);
CREATE INDEX idx_playbooks_category ON playbooks(category_id);
CREATE TRIGGER trg_playbooks_updated_at BEFORE UPDATE ON playbooks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**`011_playbook_runs.sql`**:
```sql
CREATE TABLE playbook_runs (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id INT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  playbook_id INT NOT NULL REFERENCES playbooks(id),
  playbook_version INT NOT NULL,
  current_step_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting_for_customer', 'waiting_for_human', 'complete', 'failed', 'escalated')),
  context JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_playbook_runs_thread ON playbook_runs(thread_id);
CREATE INDEX idx_playbook_runs_status ON playbook_runs(workspace_id, status);
CREATE TRIGGER trg_playbook_runs_updated_at BEFORE UPDATE ON playbook_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**`012_playbook_step_executions.sql`**:
```sql
CREATE TABLE playbook_step_executions (
  id SERIAL PRIMARY KEY,
  run_id INT NOT NULL REFERENCES playbook_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  step_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'failed', 'skipped')),
  input JSONB,
  output JSONB,
  error TEXT,
  ai_calls JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX idx_step_executions_run ON playbook_step_executions(run_id);
```

### 2. Step types and the executor

Create `api/services/playbook/` directory with:

**`types.ts`**: TypeScript interfaces for `PlaybookStep`, `StepHandler`, `RunContext`, etc. See `docs/PLAYBOOK_ENGINE.md` section "Step type definitions" for the schema.

**`executor.ts`**: The dispatch loop:
```ts
export async function advanceRun(runId: number): Promise<RunResult> {
  // 1. Load run + playbook + thread + messages
  // 2. Find the current step in playbook.steps by current_step_id
  // 3. Look up the handler for this step's type
  // 4. Execute handler with run context
  // 5. Apply the result: update context, advance to next step, or pause/complete
  // 6. Persist execution record
  // 7. If status is still 'running', recurse / loop to next step
  // 8. Return final state
}
```

**`handlers/`**: One file per step type, each exporting a `StepHandler`:
- `extract.ts`
- `find_sheet_row.ts`
- `update_sheet.ts`
- `ask_customer.ts`
- `branch.ts`
- `manual_approval.ts`
- `send_reply.ts`
- `complete.ts`
- `escalate.ts`

**`registry.ts`**: Maps step_type strings to handlers.

For Phase 2, implement at minimum: `extract`, `branch`, `ask_customer`, `send_reply`, `complete`. Enough to run the tracking playbook.

### 3. Resume mechanism

Wire up `ingestMessage` in `api/services/gmail.ts` to:
1. Check if the thread has an active `playbook_runs` row in `waiting_for_customer` status
2. If yes: call `advanceRun(runId)` instead of `categoriseAndDraft`
3. If no: existing flow (which after Phase 0 won't re-categorise existing threads)

### 4. New-thread routing

When a brand new thread arrives:
1. Categorise (existing logic)
2. If the chosen category has an active playbook: create a `playbook_runs` row with status='running', call `advanceRun`
3. If not: existing `categoriseAndDraft` behaviour (auto-reply or manual review)

### 5. Hardcoded playbook for testing

Insert a tracking-request playbook directly via SQL or a seed script:

```sql
INSERT INTO playbooks (workspace_id, category_id, name, plain_language_description, steps, version)
VALUES (1, <tracking_category_id>, 'Tracking Request', 'When someone asks where their order is...', '[
  {"id": "extract_1", "type": "extract", "variables": ["order_number"]},
  {"id": "branch_1", "type": "branch", "condition": "context.order_number != null", "if_true": "send_1", "if_false": "ask_1"},
  {"id": "ask_1", "type": "ask_customer", "message": "No worries, just need your order number to check that for you. What is it?", "on_reply_goto": "extract_1"},
  {"id": "send_1", "type": "send_reply", "message": "Sweet, your order has shipped and should be with you in the next few days. Let us know if it doesnt show up by then."},
  {"id": "complete_1", "type": "complete"}
]'::jsonb, 1);
```

### 6. End-to-end test

In dev:
1. Send an email to the test inbox: "Where's my order? It's #12345"
2. Verify: thread categorised as tracking → playbook run created → extract pulls order_number → branch goes to send_1 → reply sent → run marked complete
3. Send another email: "Where's my order?"
4. Verify: extract finds nothing → branch goes to ask_1 → ask_customer reply sent → run paused as `waiting_for_customer`
5. Reply with: "Sorry, it's #54321"
6. Verify: ingestMessage detects waiting run → resumes → extract finds 54321 → branch goes to send_1 → reply sent → run complete

Use the Postgres MCP to inspect `playbook_runs` and `playbook_step_executions` after each step.

## Workflow

1. Read `PLAYBOOK_ENGINE.md` carefully. If anything is ambiguous, ask before coding.
2. Migrations first (commit)
3. Types and executor skeleton, no handlers yet (commit)
4. Implement minimal handler set (commit per handler or one for all 5)
5. Wire up new-thread routing and resume (commit)
6. Seed the test playbook
7. Run the end-to-end test, document results in TASK_LOG
8. Propose Phase 3

## Done criteria

- [ ] Migrations applied, schema matches PLAYBOOK_ENGINE.md
- [ ] Executor + 5 minimum handlers implemented
- [ ] New-thread routing creates runs for playbook-enabled categories
- [ ] Resume on inbound works for waiting_for_customer runs
- [ ] Tracking playbook end-to-end test passes
- [ ] `categoriseAndDraft` legacy path still works for non-playbook categories
- [ ] TASK_LOG updated with full validation evidence
