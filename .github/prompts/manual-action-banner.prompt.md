---
agent: 'agent'
description: 'Build the manual action banner on the thread detail page so paused playbook runs are impossible to miss'
tools: ['search/codebase', 'edit', 'runCommands', 'mcp_postgres_query', 'mcp_context7', 'mcp_svelte', 'mcp_filesystem', 'mcp_playwright']
---

# Manual Action Banner

When a playbook run pauses at a `manual_approval` step, the human needs to do something (process a refund in Stripe, contact a supplier, fix an order). Currently this is buried in `/review`. Move it to where the human is actually looking: the thread detail page.

## Required reading

1. `.github/MCP_DOCTRINE.md` - MCP usage rules
2. `.github/copilot-instructions.md` - project context
3. `.github/instructions/frontend.instructions.md` - SvelteKit 5 conventions
4. `skills/svelte5-page/SKILL.md` - runes + page patterns
5. `skills/deno-hono-route/SKILL.md` - backend route patterns if you need to extend any
6. `docs/PLAYBOOK_ENGINE.md` - manual_approval step config schema
7. `docs/TASK_LOG.md` - recent state

## What you're building

A prominent action banner on `/threads/[id]` that appears whenever the thread has an active playbook run in `waiting_for_human` status. The banner is impossible to miss - visually distinct, top of page, with everything the human needs to take action and continue the run.

Plus a small indicator on the thread list (`/`) so threads needing action are scannable.

## Pre-build MCP work

### 1. context7 - fetch SvelteKit 5 docs

You're building a non-trivial reactive UI component. Fetch:
- SvelteKit 5 runes reference (`$state`, `$derived`, `$effect`, `$props`)
- `$derived.by()` for complex derivations
- `$effect` cleanup semantics
- Form handling without form actions (we're using API calls)
- Loading states and async patterns

Cite the specific docs sections in your code comments where relevant.

### 2. svelte MCP

Specifically check:
- Best practice for components that conditionally render based on async data
- How to bind to textarea with runes
- Modern button disabled/loading states
- Whether `$bindable()` is needed for any of the inputs

### 3. filesystem - repo awareness

Read existing patterns:

```
filesystem: list frontend/src/routes/threads/[id]/
filesystem: read frontend/src/routes/threads/[id]/+page.svelte (full)
filesystem: list frontend/src/routes/review/
filesystem: read frontend/src/routes/review/+page.svelte (look at how approval is currently done)
filesystem: read frontend/src/lib/api.ts (full - see existing API client patterns)
filesystem: read frontend/src/routes/+layout.svelte (CSS variables for theming)
filesystem: list frontend/src/lib/components/ (if it exists, see existing component patterns)
```

You're going to match the styling and patterns of what's already there, not invent new ones.

### 4. postgres - what does the data look like?

```sql
-- See an actual paused run to understand the shape
SELECT id, status, current_step_id, jsonb_pretty(context)
FROM playbook_runs
WHERE status = 'waiting_for_human'
LIMIT 3;

-- See the manual_approval step config in actual playbooks
SELECT id, name, jsonb_pretty(steps)
FROM playbooks
WHERE steps::text LIKE '%manual_approval%'
LIMIT 3;

-- Confirm the existing thread detail endpoint shape
-- Read api/routes/threads.ts for what GET /threads/:id returns
```

You need to know exactly what fields the manual_approval config has so the banner can render them correctly:
- `reason` (string, what the human needs to do)
- `capture_input` (boolean)
- `input_prompt` (string, label/placeholder for the text area)
- `input_context_key` (string, default "human_notes", where to store the input)
- `reference_context` (string[] optional, which context vars to surface to the human)

### 5. context7 - fetch Hono docs

Fetch Hono docs for:
- Route param parsing
- Body validation
- Error responses

Even if the existing approval endpoint already exists, you may need to extend it or add a "preview draft" endpoint. Don't write Hono routes from memory.

## Backend changes

### Verify the existing approval endpoint

Find and read the current approval endpoint. It probably lives in `api/routes/playbook-runs.ts` or similar. Confirm:

```
GET  /playbook-runs/:id           - returns run with current step config
POST /playbook-runs/:id/approve   - body: { input?: string }
POST /playbook-runs/:id/reject    - body: { reason?: string }
```

If `GET /playbook-runs/:id` does not currently include the **current step's full config** in the response, extend it to do so. The frontend banner needs:
- `id` (run id)
- `status`
- `current_step_id`
- `current_step_config` (the JSONB config of the current step from the playbook)
- `context` (the full context bag)

Add `current_step_config` to the response by reading the playbook's steps array, finding the step whose `id` matches `current_step_id`, and including its config.

Service-layer code (in `api/services/playbook/runs.ts` or similar):

```ts
export async function getRunWithCurrentStep(runId: number, workspaceId: number) {
  const run = await queryOne<PlaybookRun>(
    `SELECT * FROM playbook_runs WHERE id = $1 AND workspace_id = $2`,
    [runId, workspaceId]
  );
  if (!run) return null;

  const playbook = await queryOne<Playbook>(
    `SELECT * FROM playbooks WHERE id = $1`,
    [run.playbook_id]
  );
  if (!playbook) return run;

  const currentStep = (playbook.steps as PlaybookStep[]).find(
    s => s.id === run.current_step_id
  );

  return {
    ...run,
    current_step_config: currentStep?.config ?? null,
    current_step_type: currentStep?.type ?? null,
  };
}
```

Match existing service file patterns (verify via filesystem).

### Verify approve endpoint accepts input

The approve endpoint should:
1. Accept optional `{ input: string }` in the request body
2. Load the run, find the current step's `manual_approval` config
3. Read the `input_context_key` from config (default `"human_notes"`)
4. Merge `{ [input_context_key]: input }` into the run's context
5. Advance the run via the executor

If this isn't already happening, fix it. Read `api/routes/playbook-runs.ts` and the corresponding service to confirm.

## Frontend changes

### 1. Extend the API client

`frontend/src/lib/api.ts`. Add or verify:

```ts
export const api = {
  // ... existing
  playbookRuns: {
    get: (id: number) =>
      fetchJson<PlaybookRunWithStep>(`/playbook-runs/${id}`),
    approve: (id: number, body: { input?: string } = {}) =>
      fetchJson<PlaybookRun>(`/playbook-runs/${id}/approve`, {
        method: "POST",
        body
      }),
    reject: (id: number, body: { reason?: string } = {}) =>
      fetchJson<PlaybookRun>(`/playbook-runs/${id}/reject`, {
        method: "POST",
        body
      }),
  },
};
```

Add the corresponding TypeScript types in `frontend/src/lib/types.ts` (or wherever types live - check via filesystem).

### 2. Build the banner component

Create `frontend/src/lib/components/ManualActionBanner.svelte`:

```svelte
<script lang="ts">
  import { api } from "$lib/api";
  import type { PlaybookRunWithStep } from "$lib/types";

  let {
    run,
    onComplete
  }: {
    run: PlaybookRunWithStep;
    onComplete: () => void;  // parent calls to refresh thread
  } = $props();

  let humanInput = $state("");
  let submitting = $state(false);
  let error = $state<string | null>(null);

  // Derive what we show. The reason is from the step config; reference
  // context items pull from the run's context bag.
  let reason = $derived(run.current_step_config?.reason ?? "Action required");
  let captureInput = $derived(run.current_step_config?.capture_input === true);
  let inputPrompt = $derived(
    run.current_step_config?.input_prompt ?? "What did you do?"
  );
  let referenceItems = $derived.by(() => {
    const keys = run.current_step_config?.reference_context ?? [];
    return keys.map(key => ({
      key,
      value: run.context?.[key] ?? "(not set)",
    }));
  });

  async function approve() {
    submitting = true;
    error = null;
    try {
      await api.playbookRuns.approve(run.id, {
        input: captureInput ? humanInput : undefined
      });
      humanInput = "";
      onComplete();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to approve";
    } finally {
      submitting = false;
    }
  }

  async function reject() {
    if (!confirm("Reject this action and escalate the run?")) return;
    submitting = true;
    error = null;
    try {
      await api.playbookRuns.reject(run.id);
      onComplete();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to reject";
    } finally {
      submitting = false;
    }
  }

  // Disable approve if input is required but empty.
  let canApprove = $derived(
    !submitting && (!captureInput || humanInput.trim().length > 0)
  );
</script>

<div class="banner" role="alert" aria-live="polite">
  <div class="banner-header">
    <span class="banner-icon" aria-hidden="true">🔔</span>
    <h2 class="banner-title">Action required</h2>
  </div>

  <p class="banner-reason">{reason}</p>

  {#if referenceItems.length > 0}
    <dl class="reference-list">
      {#each referenceItems as item (item.key)}
        <div class="reference-row">
          <dt>{formatKey(item.key)}</dt>
          <dd>{item.value}</dd>
        </div>
      {/each}
    </dl>
  {/if}

  {#if captureInput}
    <label class="input-label" for="human-input">
      {inputPrompt}
    </label>
    <textarea
      id="human-input"
      bind:value={humanInput}
      placeholder={inputPrompt}
      rows="3"
      disabled={submitting}
    ></textarea>
  {/if}

  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}

  <div class="banner-actions">
    <button
      class="btn-primary"
      onclick={approve}
      disabled={!canApprove}
      aria-label="Mark action as done and continue the playbook run"
    >
      {submitting ? "Working…" : "Done, continue"}
    </button>
    <button
      class="btn-secondary"
      onclick={reject}
      disabled={submitting}
      aria-label="Reject this action and escalate"
    >
      Skip / escalate
    </button>
  </div>
</div>

<script context="module" lang="ts">
  // Capitalize first letter and replace underscores with spaces.
  // E.g. "customer_name" → "Customer name"
  function formatKey(key: string): string {
    return key
      .replace(/_/g, " ")
      .replace(/^./, c => c.toUpperCase());
  }
</script>

<style>
  .banner {
    background: var(--warning-bg, #2a2410);
    border: 1px solid var(--warning, #f59e0b);
    border-left-width: 4px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.5rem;
    border-radius: 0.5rem;
    color: var(--text);
  }

  .banner-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .banner-icon {
    font-size: 1.5rem;
    line-height: 1;
  }

  .banner-title {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0;
    color: var(--warning, #f59e0b);
  }

  .banner-reason {
    margin: 0 0 1rem;
    line-height: 1.5;
  }

  .reference-list {
    background: rgba(255, 255, 255, 0.04);
    border-radius: 0.375rem;
    padding: 0.75rem 1rem;
    margin: 0 0 1rem;
    font-size: 0.9rem;
  }

  .reference-row {
    display: flex;
    gap: 1rem;
    padding: 0.25rem 0;
  }

  .reference-row dt {
    font-weight: 600;
    min-width: 8rem;
    color: var(--text-muted);
  }

  .reference-row dd {
    margin: 0;
    flex: 1;
    word-break: break-word;
  }

  .input-label {
    display: block;
    font-weight: 500;
    margin-bottom: 0.375rem;
  }

  textarea {
    width: 100%;
    padding: 0.625rem;
    background: var(--bg, #0f0f0f);
    color: var(--text);
    border: 1px solid var(--border, #333);
    border-radius: 0.375rem;
    font-family: inherit;
    font-size: 0.95rem;
    margin-bottom: 1rem;
    resize: vertical;
  }

  textarea:focus {
    outline: 2px solid var(--accent, #3b82f6);
    outline-offset: -1px;
  }

  textarea:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error {
    color: var(--error, #ef4444);
    font-size: 0.9rem;
    margin: 0 0 1rem;
  }

  .banner-actions {
    display: flex;
    gap: 0.75rem;
  }

  .btn-primary {
    background: var(--success, #16a34a);
    color: white;
    padding: 0.625rem 1.5rem;
    border-radius: 0.375rem;
    border: none;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.95rem;
    transition: background 0.15s;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--success-hover, #15803d);
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: transparent;
    color: var(--text);
    padding: 0.625rem 1.5rem;
    border-radius: 0.375rem;
    border: 1px solid var(--border, #333);
    cursor: pointer;
    font-weight: 500;
    font-size: 0.95rem;
  }

  .btn-secondary:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.04);
  }

  .btn-secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
```

Adjust CSS variables to match the actual theme variables in `+layout.svelte`. Use the filesystem MCP to read them.

### 3. Wire the banner into the thread page

`frontend/src/routes/threads/[id]/+page.svelte`. Read it first via filesystem to understand current structure. Then:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { api } from "$lib/api";
  import ManualActionBanner from "$lib/components/ManualActionBanner.svelte";
  // ... existing imports

  // ... existing state (thread, loading, etc)

  // Find the active waiting_for_human run, if any.
  // A thread can have multiple historical runs; we want the active one.
  let waitingRun = $derived(
    thread?.playbook_runs?.find(r => r.status === "waiting_for_human") ?? null
  );

  // When the banner reports completion, refresh the thread to pick up new state.
  async function handleActionComplete() {
    await load();
  }
</script>

<!-- existing page header -->

{#if waitingRun}
  <ManualActionBanner
    run={waitingRun}
    onComplete={handleActionComplete}
  />
{/if}

<!-- existing thread content -->
```

Important: the thread response from `GET /threads/:id` needs to include `playbook_runs` with their `current_step_config`. Check `api/routes/threads.ts` and `api/services/threads.ts` (or wherever the service lives) and extend if necessary. Reuse the `getRunWithCurrentStep` helper from the backend changes.

### 4. Thread list indicator

`frontend/src/routes/+page.svelte`. Read it first.

For each thread in the list, add a small indicator if the thread has any waiting_for_human runs. Approach 1: include a count or boolean in the list response from the backend (cheaper). Approach 2: load runs separately (avoid).

Backend: extend the thread list query to include `has_pending_action` boolean per thread:

```sql
SELECT t.*,
  EXISTS(
    SELECT 1 FROM playbook_runs r
    WHERE r.thread_id = t.id AND r.status = 'waiting_for_human'
  ) as has_pending_action
FROM threads t
WHERE t.workspace_id = $1
ORDER BY t.updated_at DESC
LIMIT $2 OFFSET $3;
```

Frontend: render a small bell icon next to threads where `has_pending_action` is true. Use the warning colour from the banner.

```svelte
{#each threads as thread (thread.id)}
  <a href="/threads/{thread.id}" class="thread-row">
    <span class="thread-subject">{thread.subject}</span>
    {#if thread.has_pending_action}
      <span class="action-indicator" title="Action required">🔔</span>
    {/if}
    <!-- ... rest of row -->
  </a>
{/each}
```

## Verification (mandatory)

### 1. TypeScript and lint pass

```bash
cd frontend && npm run check
cd api && deno check routes/playbook-runs.ts routes/threads.ts
```

### 2. Postgres state - set up a test scenario

Find an existing run that's in `waiting_for_human` status. If none exists, trigger one by sending a fresh refund email to the test workspace and letting it reach the manual_approval step.

```sql
SELECT id, thread_id, status, current_step_id
FROM playbook_runs
WHERE status = 'waiting_for_human';
```

Note the thread_id you'll test against.

### 3. Playwright drive - the full flow

Use the playwright MCP:

1. Open `http://localhost:5173/` (or the dev frontend URL)
2. Verify the thread list shows the bell indicator next to the test thread
3. Click into the test thread (`/threads/<id>`)
4. **Verify the banner is rendered at the top of the page**
5. Verify the banner shows:
   - "Action required" header with bell icon
   - The reason text (matching what's in the manual_approval step config)
   - The reference context items (e.g. customer name, product, amount)
   - A text area with the input prompt
   - "Done, continue" and "Skip / escalate" buttons
6. Try clicking "Done, continue" with empty input - verify the button is disabled
7. Type test input: "txn_test_12345, $460"
8. Click "Done, continue"
9. Verify the button shows "Working…" briefly
10. Verify the banner disappears after submission
11. Verify the thread refreshes and shows new outbound message

Take screenshots at:
- Thread list with indicator
- Banner rendered
- Banner with input typed
- Post-submission state

### 4. Postgres verification of side effects

```sql
-- Verify the run advanced
SELECT id, status, current_step_id, jsonb_pretty(context)
FROM playbook_runs WHERE id = <run_id>;
-- Should show status = 'complete' or 'running' (advanced past approval)
-- Context should include the input you typed under the configured key

-- Verify the next steps executed
SELECT step_id, step_type, status, jsonb_pretty(output)
FROM playbook_step_executions
WHERE run_id = <run_id>
ORDER BY created_at DESC LIMIT 5;
-- Should show update_2 (sheet update) and send_1 (reply sent) and complete_1
```

### 5. Visual regression check

Take a screenshot of the thread page WITHOUT a paused run too (different thread). Verify the banner does not appear and the page layout is unaffected.

### 6. Accessibility check

Drive playwright to verify:
- Banner has `role="alert"` (screenreaders announce it)
- Buttons have `aria-label`s
- Tab order through the banner is logical (text area, then buttons)
- Disabled state on the textarea while submitting is visually clear

## Doc citation requirements

In your TASK_LOG entry, cite the specific Svelte 5 docs sections that informed:
- The `$derived.by()` choice for the reference items list
- The `$bindable()` decision (or non-decision)
- Form-without-form-action pattern

If you fetched any other docs via context7, list them.

## Done criteria

- [ ] Backend `GET /playbook-runs/:id` returns `current_step_config`
- [ ] Backend `GET /threads/:id` includes `playbook_runs` with current step config
- [ ] Backend thread list returns `has_pending_action` per thread
- [ ] Backend approve endpoint stores input under `input_context_key` (default `human_notes`)
- [ ] `ManualActionBanner.svelte` component built with proper runes, accessibility, theming
- [ ] Banner appears on thread page when run is waiting_for_human
- [ ] Banner allows input capture, approve, reject
- [ ] Thread list shows indicator for threads needing action
- [ ] All TypeScript and Deno checks pass
- [ ] Playwright verified full flow with screenshots
- [ ] Postgres confirmed side effects (input stored, run advanced, sheet updated)
- [ ] TASK_LOG updated with MCP usage trace and doc citations
- [ ] Commit message: `feat(thread): manual action banner for paused playbook runs`

## What NOT to do

- Don't build a generic notification system, just this banner
- Don't add real-time updates (polling/SSE) - manual refresh is fine for now
- Don't redesign the review queue - this is additive, the queue still exists
- Don't add complex animation
- Don't add a Tailwind/UnoCSS dependency
- Don't expand scope to handle other run statuses
