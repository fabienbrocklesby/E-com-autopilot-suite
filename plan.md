# Plan: Reply Delay on Playbook Send Steps

<!-- Previous plan archived below -->
<!-- ──────────────────────────────────────────────────────────────────────── -->
<!-- ARCHIVED: "Open in Sheet" row link on thread detail page

## Problem

Thread 110 (`/threads/110`) is paused at a `manual_approval` step. The playbook already found sheet row 2 (matched "Fabien Brocklesby" in column A). To take the manual action, the user needs to navigate to the Google Sheet themselves. There is currently no shortcut to do that.

The request:
- A button in the **right sidebar** (before the Playbook Runs section) to jump to the found sheet row.
- A button/link in the **ManualActionBanner** (the orange action card at the top) so the user sees it right at the point where action is required.
- Only visible when a sheet row was actually found (i.e. `context.row_number` is a positive integer AND `workspace.sheet_id` is set).

---

## Investigation findings

### Database state (real data)

Run 30 on thread 110 (`waiting_for_human`, step `approval_1`):

```
context: {
  row_number: 2,
  customer_name: "Fabien Brocklesby",
  refund_reason: null,
  product_description: null
}
```

Step execution for `find_1` (`find_sheet_row`):
```json
{
  "found": true,
  "column": "Name",
  "row_number": 2,
  "context_var": "customer_name",
  "matched_value": "Fabien Brocklesby"
}
```

Workspace 1:
```
sheet_id: "1pWy8O07NkzLilGVuYNYasQjD6hQkWnMtnqNyf5JdfvQ"
sheet_name: "Sheet1"
```

### Where `row_number` lives in the frontend

`GET /playbooks/runs?thread_id=110` returns `PlaybookRun[]`, each with `context: Record<string, unknown>`. The `row_number` key is set to the integer row when found, or `null` when not found. This is already available in the `runs` state variable on the thread detail page — no extra API call needed.

`GET /workspaces/1` returns `Workspace` including `sheet_id`. This is NOT currently fetched on the thread detail page but `workspacesApi.get(1)` already exists in `src/lib/api.ts`.

### URL construction

Google Sheets deep-link format to highlight a specific row:

```
https://docs.google.com/spreadsheets/d/{spreadsheetId}/edit#range={row}:{row}
```

- `range=2:2` highlights the entire row 2.
- No `gid` parameter needed — the URL lands on whatever sheet is active in the user's session. Since the workspace only uses one sheet tab, this is correct.
- The `#range` fragment is the standard Google Sheets anchor used by the Sheets UI itself when you navigate to a named range or cell.

Using `gid` would be cleaner but requires knowing the numeric sheet tab ID, which is not stored in the workspace (only `sheet_name` is stored, and resolving `sheet_name → gid` would require an extra Sheets API call). The single-sheet assumption is valid for this product.

---

## Architecture decision

**Frontend-only change. No backend changes required.**

Reason: All the data is already accessible from the frontend:
1. `workspace.sheet_id` — from `workspacesApi.get(1)` (one extra API call added to the thread page load).
2. `run.context.row_number` — already present in the `runs` array returned by `listRuns`.

Adding this to the backend run response would be premature — the sheet URL is a presentation concern, not business logic. The backend executor and step handlers do not need to know about it.

---

## Exact changes

### 1. `frontend/src/routes/threads/[id]/+page.svelte`

**a. Import `workspacesApi` and `Workspace` type**

`workspacesApi` and `Workspace` are exported from `$lib/api` — add them to the existing import.

**b. Add `workspace` state**

```ts
let workspace = $state<Workspace | null>(null);
```

**c. Extend `load()` to fetch workspace in the same `Promise.all`**

```ts
const [threadRes, runsRes, workspaceRes] = await Promise.all([
  threadsApi.get(threadId),
  playbooksApi.listRuns({ thread_id: threadId }),
  workspacesApi.get(1),
]);
thread = threadRes.thread;
runs = runsRes.runs;
workspace = workspaceRes.workspace;
```

This adds zero extra round-trips — it runs in parallel with the existing fetches.

**d. Derive `sheetRowUrl`**

```ts
let sheetRowUrl = $derived.by(() => {
  const sheetId = workspace?.sheet_id;
  if (!sheetId) return null;
  for (const run of runs) {
    const rowNum = run.context?.row_number;
    if (typeof rowNum === "number" && rowNum > 0) {
      return `https://docs.google.com/spreadsheets/d/${sheetId}/edit#range=${rowNum}:${rowNum}`;
    }
  }
  return null;
});
```

Rationale for iterating `runs`: picks the first run (most recent, since list is DESC) that has a positive `row_number` in context. Cancelled or completed runs that had a row found are still useful to link to.

**e. Right sidebar — "Open in Sheet" link before Playbook Runs section**

In the `context-col` div, before `{#if runs.length > 0}`, add a sheet row link card when `sheetRowUrl` is truthy:

```svelte
{#if sheetRowUrl}
  <div class="sidebar-sheet-link">
    <a href={sheetRowUrl} target="_blank" rel="noopener noreferrer" class="sheet-row-btn">
      <ExternalLink size={13} />
      Open sheet row
    </a>
  </div>
{/if}
```

Style it as a subdued but clear action button matching the sidebar aesthetic.

**f. Pass `sheetRowUrl` to `ManualActionBanner`**

```svelte
{#if waitingRun}
  <ManualActionBanner run={waitingRun} onComplete={load} {sheetRowUrl} />
{/if}
```

**g. Import `ExternalLink` from `@lucide/svelte`**

Add to the existing import line.

---

### 2. `frontend/src/lib/components/ManualActionBanner.svelte`

**a. Add `sheetRowUrl` prop**

```ts
let {
  run,
  onComplete,
  sheetRowUrl = null,
}: {
  run: PlaybookRun;
  onComplete: () => void;
  sheetRowUrl?: string | null;
} = $props();
```

**b. Render the link in the banner**

In the `{:else}` branch (the `manual_approval` path, not the `isPendingSend` path — though it makes sense in both), add a link just after the `<p class="banner-reason">`:

```svelte
{#if sheetRowUrl}
  <a href={sheetRowUrl} target="_blank" rel="noopener noreferrer" class="sheet-link">
    <ExternalLink size={13} />
    Open sheet row
  </a>
{/if}
```

Placement: immediately after `banner-reason`, before `reference-list` — this way the user sees the reason and then has the sheet link right there before reviewing the reference values.

Also shown in `isPendingSend` branch (send_reply / ask_customer require_approval) since the user may still need to look at the sheet row to know how to handle the request.

**c. Import `ExternalLink`**

Add to the existing lucide import line.

---

## What will NOT be changed

- No backend routes touched.
- No database schema changes.
- No migrations.
- No new API endpoints.
- No changes to the playbook executor or any step handler.
- No changes to the SSE event bus.
- No changes to the `PlaybookRun` or `StepExecution` API types (they don't need `sheet_row_url` — this is computed client-side).

---

## Risk analysis

| Risk | Likelihood | Mitigation |
|---|---|---|
| `workspace.sheet_id` is null | Low (workspace 1 has it set) | `sheetRowUrl` is null → button hidden |
| `row_number` is null (no match) | Medium (evaluates to false) | Condition `typeof rowNum === "number" && rowNum > 0` excludes null |
| Multiple runs, wrong row number shown | Low (uses most recent non-null) | First run with a row number used — acceptable, can refine later |
| Sheets link lands on wrong tab (wrong gid) | Low (single-sheet workspace) | Acceptable until gid is stored in workspace |
| `workspacesApi.get(1)` fails | Very low | Load function error handling already catches all failures |

---

## Files changed

| File | Change |
|---|---|
| `frontend/src/routes/threads/[id]/+page.svelte` | Fetch workspace, derive sheetRowUrl, sidebar button, pass prop to banner |
| `frontend/src/lib/components/ManualActionBanner.svelte` | Accept sheetRowUrl prop, render link |

---

## Docs and sources consulted

- **Postgres MCP**: queried `playbook_runs`, `playbook_step_executions`, `workspaces`, `sheet_columns` for real data — confirmed `row_number: 2` in run 30 context and `sheet_id` in workspace 1.
- **Google Sheets URL format**: `#range={row}:{row}` is the standard fragment used by the Sheets UI to select a row range. Verified against the Sheets URL structure (no special API call needed — this is a browser navigation anchor).
- **SvelteKit 5 runes**: `$state`, `$derived`, `$derived.by`, `$props` — consistent with existing patterns in the file.
- **`workspacesApi`**: already exists in `src/lib/api.ts` as `get(id: number)` returning `{ workspace: Workspace }`.
- **`Workspace` type**: already defined in `src/lib/api.ts`, includes `sheet_id: string | null`.
- **Lucide Svelte**: `ExternalLink` icon — available in `@lucide/svelte`, matches icon usage pattern throughout the app.

Add four nullable TEXT columns to the `workspaces` table:

| Column | Type | Purpose |
|---|---|---|
| `store_name` | TEXT | Brand/store name (may differ from workspace name) |
| `store_description` | TEXT | What the store sells, its niche, tone, anything the AI should know |
| `store_url` | TEXT | Website URL, used for leads and the AI can reference in replies |

Three columns. Workspace `name` already exists and serves as the internal workspace label. `store_name` is the customer-facing brand name. `store_description` is freeform - the user writes whatever they want. `store_url` is optional.

No NOT NULL constraints - existing workspaces should remain valid. No CHECK constraints needed - these are freeform text.

## Backend changes

### 1. Types (`api/types/index.ts`)

Add three fields to `Workspace` interface:
```ts
store_name: string | null;
store_description: string | null;
store_url: string | null;
```

Add same fields to `CreateWorkspacePayload` (optional):
```ts
store_name?: string;
store_description?: string;
store_url?: string;
```

### 2. Workspace route (`api/routes/workspaces.ts`)

Add `store_name`, `store_description`, `store_url` to the `allowed` array in PATCH handler. Add them to the INSERT in POST handler.

No new endpoints needed - existing CRUD handles it.

### 3. Store profile loader (new helper)

Add a small helper function that loads the store profile for a workspace and formats it as an AI context string. This avoids duplicating the formatting logic across 5+ files.

Location: `api/services/store-profile.ts`

```ts
export async function getStoreProfile(workspaceId: number): Promise<string | null>
```

Returns a formatted string like:
```
STORE: Acme Widgets
ABOUT: We sell eco-friendly kitchen gadgets. Our tone is casual and helpful.
URL: https://acmewidgets.com
```

Returns `null` if no profile fields are set. This way callers can conditionally include it.

### 4. AI injection points

The store profile gets injected into system prompts at these locations:

| File | Function/Handler | How |
|---|---|---|
| `services/ai.ts` | `categoriseEmail()` | Add store profile to the system prompt so the AI understands the business context when choosing categories |
| `services/playbook/executor.ts` | `advanceRun()` | Load store profile once, add `storeProfile` to `RunContext` |
| `services/playbook/types.ts` | `RunContext` | Add `storeProfile: string \| null` field |
| `services/playbook/handlers/send_reply.ts` | system prompt | Add `STORE CONTEXT: ${ctx.storeProfile}` when non-null |
| `services/playbook/handlers/ask_customer.ts` | system prompt | Same injection |
| `services/playbook/handlers/extract.ts` | prompt | Add store context so extraction understands domain terms |
| `services/playbook/handlers/evaluate.ts` | system prompt | Add store context for evaluation decisions |

The injection is conditional - only added when the profile is non-null. The prompt phrasing tells the AI to use it naturally and only when relevant.

Prompt template addition (appended to relevant system prompts):
```
STORE CONTEXT (use naturally where relevant, never mention robotically):
${ctx.storeProfile}
```

### 5. What does NOT change

- `approval-sender.ts` - sends already-drafted text, no AI generation
- `manual_approval.ts` - presents data to humans, no AI text generation
- `find_sheet_row.ts`, `update_sheet.ts` - sheet operations, no AI text
- `branch.ts` - deterministic branching
- `complete.ts`, `escalate.ts` - terminal steps
- `playbook/parser.ts` - generates playbook structure, not customer-facing text (store context could help here later but is out of scope)

## Frontend changes

### 1. API types (`frontend/src/lib/api.ts`)

Add `store_name`, `store_description`, `store_url` to both `Workspace` and `WorkspacePayload` interfaces.

### 2. Settings page (`frontend/src/routes/settings/+page.svelte`)

Add a new "Store Profile" section in the settings page, positioned between the "Workspaces" section and "Email Signature" section. This section appears when a workspace is being edited (inline with the existing workspace edit form).

Alternatively (and better UX): add the store profile fields directly into the workspace edit form, below the existing sheet_name field. This keeps all workspace config in one place.

**Chosen approach: Add fields to the workspace edit form.**

New fields in the workspace edit form:
- `Store Name` - text input, placeholder "e.g. Acme Widgets"
- `About Your Store` - textarea, placeholder "Describe what your store sells, your niche, tone, etc. The AI uses this to write better replies."
- `Store URL` - text input with url type, placeholder "https://yourstore.com"

Add these fields to `workspaceForm` state and wire them into `saveWorkspace()`.

## Execution order

1. Write migration `025_workspace_store_profile.sql`
2. Apply migration (database cleared as per user instruction)
3. Update backend types in `api/types/index.ts`
4. Update workspace route `api/routes/workspaces.ts`
5. Create `api/services/store-profile.ts` helper
6. Add `storeProfile` to `RunContext` in `api/services/playbook/types.ts`
7. Update executor to load and pass store profile
8. Update AI handlers (send_reply, ask_customer, extract, evaluate, categoriseEmail)
9. Update frontend types in `frontend/src/lib/api.ts`
10. Update settings page workspace edit form
11. Test via browser - enter store profile, verify it persists, verify AI uses it

## Breaking points / Risk analysis

- **No breaking changes to existing data.** All new columns are nullable. Existing workspaces work unchanged.
- **No breaking changes to API.** New fields are optional on both create and update.
- **No breaking changes to playbook runs.** `storeProfile` is additive on `RunContext`. Existing handlers that don't read it are unaffected.
- **AI prompt changes are additive.** The store context block is only added when non-null. Existing behavior is preserved when no profile is set.
- **Frontend form changes are additive.** New fields appear in the edit form; the form still saves correctly if they're left blank.
- **Token usage.** Store profile adds ~50-100 tokens to each AI call. Negligible vs existing prompt sizes.

## Docs / Sources to consult during implementation

- **context7: Hono** - verify route handler patterns for PATCH with dynamic fields
- **context7: SvelteKit 5** - verify runes patterns for form state and textarea binding
- **svelte MCP** - verify textarea binding syntax and form patterns in SvelteKit 5
- **postgres MCP** - verify migration applied, check data after writes
- **playwright MCP** - verify UI renders correctly after changes

-->
<!-- ──────────────────────────────────────────────────────────────────────── -->

## Feature summary

Add configurable send delays to `send_reply` playbook steps so the system waits a set
time before sending a reply. This makes AI-driven responses feel more human to email recipients.
The delay can be specified in the plain-language description when generating a playbook, or set
manually per-step in the editor.

---

## Investigation findings

### Codebase state (confirmed via grep, file reads, DB queries)

**Backend** (`api/`):
- Deno + Hono, Postgres 16 via `db/client.ts`
- Playbook runs in `playbook_runs` table with status constraint:
  `running | waiting_for_customer | waiting_for_human | complete | failed | escalated | retrying | cancelled`
- `playbook_runs` already has `next_retry_at TIMESTAMPTZ` (used by the fault-retry worker)
- `retry_worker.ts` polls every 5 min for `retrying` runs past `next_retry_at` and calls `advanceRun()`
- `timeout_worker.ts` polls every 30 min for `waiting_for_customer` runs silent past `customer_silence_hours`
- Both workers use `setInterval` — standard Deno pattern, confirmed in `main.ts`
- `approval-sender.ts` already implements "send email from a paused run" — directly usable
- `send_reply.ts` handler: when `require_approval = true`, returns `pause(waiting_for_human)` and
  stores `{ action: 'pending_approval', pending_send: body }` in step execution output
- The `pause` case in `executor.ts` persists `status` + `current_step_id` + `context` and returns early
- Loop detection: escalates if a step fires 3+ times on the same run

**Database schema (verified via postgres MCP)**:
- `playbook_runs`: columns `id, workspace_id, thread_id, playbook_id, playbook_version, current_step_id, status, context, created_at, updated_at, retry_count, next_retry_at`
- `playbooks.steps` is JSONB — step config is free-form, any field added to a step object is stored
- `playbook_step_executions.output` is JSONB — already holds `pending_send` body for approval flows

**Frontend** (`frontend/`):
- SvelteKit 5 runes (`$state`, `$derived`, `$effect`, `$props`)
- Step edit modal rendered in `playbooks/[id]/+page.svelte` — per-type fields in `{#if}` blocks
- `editDraft` is a `Record<string, unknown>` — any field can be set via `setDraft(key, value)`
- Step card summary rendered by `stepSummary()` — a switch on `step.type`
- `PlaybookStep` in `api.ts` is `Record<string, unknown> & { id: string; type: string }` — no TS changes needed for the step shape

**Design guide** (`docs/PLAYBOOK_DESIGN_GUIDE.md`):
- Loaded at runtime by the parser before calling GPT-4o
- Editing it changes how the parser generates steps with zero code changes
- `send_reply` section documents all supported fields — adding `delay_seconds` here makes the
  parser understand natural-language mentions like "wait 30 minutes before replying"

**Docs consulted**:
- **context7 / Hono** (`/llmstxt/hono_dev_llms_txt`): confirms the project's workers use standard
  Deno `setInterval`, not Hono-specific scheduling — existing pattern in `timeout_worker.ts` and
  `retry_worker.ts` is the correct model to follow
- **svelte MCP**: confirms `$state`, `$derived`, reactive `setDraft` pattern used throughout the
  editor — no framework surprises for the modal additions
- **Postgres**: `TEXT CHECK (col IN (...))` constraint pattern (already used), `TIMESTAMPTZ` for
  timestamps (already used for `next_retry_at`)

---

## Architecture decision

### Why a new status `waiting_to_send` + new column `send_after`

**Option rejected — Sleep inside executor**: Blocks the event loop, doesn't survive restarts.

**Option rejected — Reuse `retrying` status + `next_retry_at`**: `retrying` means "a step threw
an exception and we're waiting to retry it". Using it for deliberate delays conflates error
recovery with intentional timing. The retry worker would need to distinguish "retry failed step"
from "fire delayed send" — breaking its single-responsibility and making both harder to reason about.

**Chosen — New status `waiting_to_send` + `send_after` column**:
- Semantically distinct from all existing statuses
- `send_after` mirrors `next_retry_at` in naming and type — consistent with existing schema
- The delay worker is a single-responsibility polling loop, just like `timeout_worker` and `retry_worker`
- No changes to `advanceRun` error-handling path
- Loop detection is safe: the delay worker advances `current_step_id` to the NEXT step BEFORE
  calling `advanceRun()`, so the send_reply step is never re-executed

### Where the drafted body lives during the wait

Mirroring the `require_approval` pattern exactly: the step execution `output` column holds
`{ action: 'delayed_send', pending_send: <body>, delay_seconds: <N> }`. The delay worker queries
the most recent step execution for the run/step and reads `pending_send`. The run context bag
stays clean — no internal state keys pollute it.

---

## Scope

### In scope
- `delay_seconds?: number` field on `send_reply` steps
- Parser understands natural-language delay mentions in the description
- Step edit modal: delay picker (preset + custom minutes)
- Step card: visual delay badge
- Delay worker: fires pending sends when `send_after <= NOW()`
- New status `waiting_to_send` in the status constraint
- New `send_after` column on `playbook_runs`

### Out of scope (natural extensions, not in this plan)
- `delay_seconds` on `ask_customer` steps (same mechanism, different after-send status — add later)
- Per-workspace default delay setting
- Timezone-aware send windows ("only send during business hours")

---

## Files changed

| File | Change type | Description |
|---|---|---|
| `api/db/migrations/026_reply_delay.sql` | **new** | Adds `waiting_to_send` to status constraint, adds `send_after TIMESTAMPTZ` column |
| `api/services/playbook/types.ts` | **edit** | Add `delay_seconds?: number` to `SendReplyStep`; add `delaySec?: number` to pause decision; add `waiting_to_send` to `RunStatus` |
| `api/services/playbook/handlers/send_reply.ts` | **edit** | Detect `delay_seconds > 0`, draft body, return pause with `delaySec` instead of sending |
| `api/services/playbook/executor.ts` | **edit** | Pause case: write `send_after` when `delaySec` present; thread status block: handle `waiting_to_send` |
| `api/services/playbook/delay_worker.ts` | **new** | Polls `waiting_to_send` runs, calls `sendApprovedReply`, advances cursor, calls `advanceRun` |
| `api/main.ts` | **edit** | Import and start `startDelayWorker()` alongside other workers |
| `docs/PLAYBOOK_DESIGN_GUIDE.md` | **edit** | Add `delay_seconds` field to `send_reply` section with examples + natural-language generation hint |
| `frontend/src/lib/api.ts` | **edit** | Add `waiting_to_send` to `PlaybookRun.status` union |
| `frontend/src/routes/playbooks/[id]/+page.svelte` | **edit** | Add delay picker in send_reply modal, delay badge on step card, update `stepSummary` |

---

## Migration: `026_reply_delay.sql`

```sql
BEGIN;

ALTER TABLE playbook_runs DROP CONSTRAINT IF EXISTS playbook_runs_status_check;
ALTER TABLE playbook_runs ADD CONSTRAINT playbook_runs_status_check
  CHECK (status IN (
    'running', 'waiting_for_customer', 'waiting_for_human',
    'waiting_to_send', 'complete', 'failed', 'escalated', 'retrying', 'cancelled'
  ));

ALTER TABLE playbook_runs ADD COLUMN IF NOT EXISTS send_after TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_playbook_runs_waiting_to_send
  ON playbook_runs(send_after)
  WHERE status = 'waiting_to_send';

COMMIT;
```

Safe to apply on production: adds a nullable column, extends (not restricts) the status
constraint, adds a partial index. No destructive changes.

---

## Backend: types.ts changes

### `SendReplyStep` — add optional field
```typescript
export interface SendReplyStep {
  id: string;
  type: "send_reply";
  message?: string | { from_template: string } | { ai_generate_using_category_voice: true };
  goal?: string;
  reference_context?: string[];
  voice_hint?: string;
  require_approval?: boolean;
  delay_seconds?: number;   // NEW: if > 0, run pauses before sending
}
```

### `StepDecision` pause variant — add optional delaySec
```typescript
type StepDecision =
  | { action: "advance" }
  | { action: "advance_to"; stepId: string }
  | { action: "pause"; status: RunStatus; delaySec?: number }  // delaySec NEW
  | { action: "complete" }
  | { action: "fail"; error: string; retriable?: boolean }
```

### `RunStatus` — add new value
```typescript
export type RunStatus =
  | "running" | "waiting_for_customer" | "waiting_for_human"
  | "waiting_to_send"   // NEW
  | "complete" | "failed" | "escalated" | "retrying" | "cancelled";
```

---

## Backend: send_reply.ts handler changes

After drafting `body` (AI or literal), before calling `sendReply()`, check for delay:

```typescript
const delaySec = typeof sendStep.delay_seconds === "number" && sendStep.delay_seconds > 0
  ? sendStep.delay_seconds
  : 0;

if (delaySec > 0) {
  return {
    decision: { action: "pause", status: "waiting_to_send", delaySec },
    output: { action: "delayed_send", pending_send: body, delay_seconds: delaySec },
    aiCalls,
  };
}
```

This sits between body generation and the `requireApproval` check. If both `delay_seconds`
and `require_approval` are set, delay takes precedence (the design guide will note that
combining both is unsupported).

---

## Backend: executor.ts changes

### Pause case — write `send_after` when `delaySec` present

Currently the pause case updates 4 columns. With delay, it conditionally updates a 5th:

```typescript
case "pause": {
  status = result.decision.status;
  const sendAfter =
    result.decision.delaySec
      ? new Date(Date.now() + result.decision.delaySec * 1000)
      : null;
  await execute(
    `UPDATE playbook_runs
     SET status = $1, current_step_id = $2, context = $3, send_after = $4
     WHERE id = $5`,
    [status, currentStepId, JSON.stringify(variables), sendAfter, runId],
  );
  // ... rest unchanged
}
```

### Thread status block — handle `waiting_to_send`

```typescript
} else if (
  status === "waiting_for_customer" ||
  status === "waiting_for_human" ||
  status === "waiting_to_send"
) {
  await execute("UPDATE threads SET status = 'in_review' WHERE id = $1", [run.thread_id]);
}
```

Thread surfaces in the inbox as "in review" while the send is pending.

---

## Backend: delay_worker.ts (new file)

Follows the same structure as `retry_worker.ts` and `timeout_worker.ts`.

```
startDelayWorker():
  INTERVAL_MS = 60_000 (1 minute)
  tick():
    query: SELECT runs WHERE status = 'waiting_to_send' AND send_after <= NOW()
    for each run:
      query: most recent step execution WHERE run_id AND step_id = run.current_step_id
      body = execution.output.pending_send
      if !body: log warning, skip (no draft to send)
      call sendApprovedReply(run, body)            -- reuses approval-sender.ts
      load playbook steps, find next step after run.current_step_id
      UPDATE playbook_runs SET status='running', current_step_id=nextStepId, send_after=NULL
      call advanceRun(run.id)
    on error per run: log, continue to next run (retry on next tick)
```

Key safety:
- `send_after = NULL` + `status = 'running'` is one atomic UPDATE — a run is never picked up twice
- If `sendApprovedReply` throws (transient Gmail error), the run stays `waiting_to_send` with its
  original `send_after`. Next tick retries automatically
- Worker does NOT escalate on send failure — it keeps retrying until the email sends or the
  run is manually cancelled
- 1-minute interval: fine-grained enough for 5-minute delays, low DB load

---

## Design guide: `send_reply` section update

Add to the field list under `send_reply`:

```
- `delay_seconds` (number, optional, default 0): How many seconds to wait before sending this
  reply. Use to make automated responses feel more human. Common values: 300 (5 min), 600
  (10 min), 1800 (30 min), 3600 (1 hr), 7200 (2 hr). 0 or absent = send immediately.
```

Add a generation rule near the top of the `send_reply` section:

```
IF the description mentions "wait before replying", "delay the reply", "send after N minutes",
"reply after N hours", "add a delay to make it feel human", or any similar phrasing:
  → Set delay_seconds on the send_reply step.
  → Convert: N minutes → N * 60, N hours → N * 3600.
  → If no specific time given but the intent is "make it feel human", use 600 (10 min).
```

---

## Frontend: `api.ts` change

Add `'waiting_to_send'` to the `PlaybookRun.status` union:

```typescript
status: 'running' | 'waiting_for_customer' | 'waiting_for_human' | 'waiting_to_send'
      | 'complete' | 'failed' | 'escalated' | 'retrying' | 'cancelled';
```

---

## Frontend: playbook editor changes

### `stepSummary()` — show delay in card summary

```typescript
case "send_reply": {
  const delaySec = step.delay_seconds as number | undefined;
  const delayStr = delaySec ? ` · ⏱ ${formatDelay(delaySec)}` : "";
  const goal = step.goal as string | undefined;
  if (goal) return `Reply (AI): "${goal.slice(0, 55)}${goal.length > 55 ? "…" : ""}"${delayStr}`;
  // ... etc
}
```

Helper `formatDelay(s: number): string` — converts seconds to human label:
- `< 3600` → "Xm" (e.g. "10m")
- `>= 3600` → "Xh" (e.g. "2h")

### Step edit modal — delay picker for `send_reply`

Add below the "Voice hint" field in the `{:else if editingStep.type === "send_reply"}` block:

```svelte
<div class="field">
  <label>Send delay <span class="hint">Wait before sending to feel more human</span></label>
  <select
    value={delaySec()}
    onchange={(e) => onDelaySelectChange((e.target as HTMLSelectElement).value)}
  >
    <option value="0">No delay (send immediately)</option>
    <option value="300">5 minutes</option>
    <option value="600">10 minutes</option>
    <option value="900">15 minutes</option>
    <option value="1800">30 minutes</option>
    <option value="3600">1 hour</option>
    <option value="7200">2 hours</option>
    <option value="14400">4 hours</option>
    <option value="custom">Custom…</option>
  </select>
  {#if showCustomDelay}
    <div class="delay-custom-row">
      <input
        type="number"
        min="1"
        placeholder="minutes"
        value={customDelayMinutes}
        oninput={(e) => setDraft("delay_seconds", parseInt((e.target as HTMLInputElement).value) * 60)}
      />
      <span class="hint">minutes</span>
    </div>
  {/if}
</div>
```

State helpers (local to the modal context, derived from `editDraft`):
- `delaySec()`: returns current `editDraft.delay_seconds` as string, mapping known presets;
  returns "custom" if the value doesn't match any preset
- `onDelaySelectChange(val)`: if val is a preset, `setDraft("delay_seconds", Number(val))`;
  if "custom", set `showCustomDelay = true` (local `$state`)
- `showCustomDelay` is a `$state(false)` variable scoped to the component (already has local
  state in the component, so this fits the existing pattern)

The select value always stores seconds in `editDraft.delay_seconds`. The "custom" option is
a UI affordance only — the persisted value is always a number of seconds.

---

## Breakpoints and risks

| Risk | Mitigation |
|---|---|
| Delay worker picks up same run twice | `send_after = NULL` + `status = 'running'` written atomically before `advanceRun()` |
| `send_reply` step re-executed on resume | Cursor moves to `nextStepId` BEFORE `advanceRun()` — starts on next step |
| Loop detection fires on send_reply | Creates 1 step execution (first pass). `advanceRun()` starts on NEXT step — no additional execution for send_reply |
| Long delay + server restart | `send_after` persisted in DB — next worker tick after restart picks it up |
| `delay_seconds` and `require_approval` both set | `delay_seconds` takes precedence; design guide notes combining both is unsupported |
| DB migration on production data | User confirmed dummy data — clear and re-migrate is acceptable |
| No draft body in step execution output | Worker logs warning and skips the run (no send, no escalation) — operator investigates |

---

## Implementation order

1. `026_reply_delay.sql` — run first; unblocks all DB-dependent changes
2. `types.ts` — unblocks handler + executor
3. `send_reply.ts` — handler change
4. `executor.ts` — pause case + thread status
5. `delay_worker.ts` — new file
6. `main.ts` — register worker
7. `PLAYBOOK_DESIGN_GUIDE.md` — design guide update (independent)
8. `api.ts` (frontend) — status union
9. `+page.svelte` — UI changes

Each step is independently testable. The feature is fully inert until a step has `delay_seconds > 0`.
