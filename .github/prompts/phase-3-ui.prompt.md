---
agent: 'agent'
description: 'Phase 3: build the playbook editor UI and observability'
tools: ['search/codebase', 'edit', 'runCommands', 'mcp_postgres_query', 'mcp_playwright']
---

# Phase 3: Playbook UI

Goal: Make the playbook engine usable by the client. They write playbooks in plain language, see them parsed into steps, tune individual steps. Plus visibility into running playbooks per thread.

## Required reading

- `docs/PLAYBOOK_ENGINE.md` sections "Plain-language to structured magic" and "UX principles"
- `docs/TASK_LOG.md` - confirm Phase 2 is done with passing end-to-end test
- `frontend/src/routes/categories/+page.svelte` - current category editor

## Tasks

### 1. Backend: playbook parser

`POST /playbooks/parse` - takes plain-language description, returns structured steps.

In `api/services/playbook/parser.ts`:
- Build a system prompt that lists available step types, available context variables (extract from the workspace's known fields), available sheet columns
- Call `chatCompletion` with `responseFormat: 'json_object'`
- Validate returned JSON against the step schema
- Return parsed steps + any warnings

`POST /playbooks` - create
`PUT /playbooks/:id` - update (creates new version if steps changed)
`GET /playbooks` - list
`GET /playbooks/:id` - detail with version history

### 2. Frontend: playbook editor page

New route: `/playbooks/[id]/+page.svelte`

Layout:
- Top: category selector (which category does this playbook serve), name field
- Middle-left: large textarea for plain-language description, "Generate Steps" button
- Middle-right: rendered step list, each step a card with type icon, summary, expand-to-edit
- Bottom: "Save" + "Save and Activate" buttons

When user clicks "Generate Steps":
- Call `/playbooks/parse`
- Render returned steps as cards
- Preserve any user-edited individual steps if step IDs match

Per-step edit modals:
- `extract`: list of variable names to extract
- `find_sheet_row`: which columns to try matching, in order
- `update_sheet`: row reference + column-value pairs
- `ask_customer`: message text (with variable interpolation: `{customer_name}`)
- `branch`: condition expression + true-goto + false-goto
- `manual_approval`: reason + optional draft template
- `send_reply`: message text or "AI generates from category style"
- `complete` / `escalate`: no config

### 3. Frontend: playbook list page

`/playbooks/+page.svelte` - table of all playbooks for the workspace:
- Name, category, version, active, last edited
- Actions: edit, duplicate, deactivate, delete

### 4. Frontend: thread detail observability

Update `/threads/[id]/+page.svelte`:
- If thread has an active or completed playbook run, show:
  - Current playbook + version
  - Visual step pipeline (which steps ran, current step, pending steps)
  - Context bag (key-value table of extracted variables)
  - Per-step execution log: time, status, AI calls (collapsible), inputs/outputs

This is for debugging. Make it functional, not pretty.

### 5. Dry-run feature

In the playbook editor, add "Test with example email" button:
- Opens a modal with a textarea
- User pastes example email content
- Backend creates a sandboxed run (no actual emails sent, no actual sheet writes), executes the playbook against the example, returns the trace
- Frontend shows the trace inline: which steps would run, what variables would extract, what reply would send

This is the trust-builder. The client sees the playbook work before deploying it.

### 6. Updated review queue

Update `/review/+page.svelte`:
- Group manual_approval steps by their `reason` field
- Show the playbook + step that triggered the pause
- Approve action resumes the playbook from that step
- Reject action escalates the run

### 7. End-to-end test with Playwright MCP

Use the Playwright MCP to:
1. Open the dashboard
2. Create a new playbook with the refund description from PLAYBOOK_ENGINE.md
3. Verify steps generate correctly
4. Edit one step
5. Save and activate
6. Trigger a test email (or use dry-run)
7. Verify behaviour end-to-end

## Workflow

1. Confirm Phase 2 done with passing test
2. Backend parser first (commit)
3. Backend playbook CRUD (commit)
4. Frontend playbook list page (commit)
5. Frontend playbook editor with parser integration (commit)
6. Per-step edit modals (commit per ~3 step types)
7. Thread detail observability (commit)
8. Dry-run feature (commit)
9. Review queue update (commit)
10. Playwright test (commit)
11. Update TASK_LOG, propose Phase 4

## Done criteria

- [ ] Plain-language → structured steps works for all 5 example playbooks in PLAYBOOK_ENGINE.md
- [ ] All 9 step types editable via per-step modals
- [ ] Thread detail shows full playbook run state
- [ ] Dry-run produces accurate trace without side effects
- [ ] Review queue properly resumes paused runs
- [ ] Playwright end-to-end test passes
- [ ] TASK_LOG updated
