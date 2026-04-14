# Task Log

This is the living record of work on this project. New entries at the top. Used by Copilot to know what's been done and what's next.

## Format

Each entry:
- Date
- Phase + status
- What was done (with file/migration references)
- Validation (how was it verified)
- Decisions (what choices were made)
- Open questions
- Next

---

## 2026-04-14 — Phase 5: Smart Playbooks

**Phase**: Phase 5
**Status**: complete

### What was done

**Change 1 — Loop detection in executor**
- `api/services/playbook/executor.ts`: Added `escalateRunDueToLoop()` helper. Before each step execution, queries the last 10 step executions: if the same step has fired 3+ times, or total executions exceed 50, the run is escalated with a `_loop_detected` sentinel step execution. Thread is moved to `in_review`.

**Change 2 — AI-driven `ask_customer`**
- `api/services/playbook/types.ts`: Updated `AskCustomerStep` to support `goal`, `required_context`, `voice_hint` (new) alongside legacy `message` field.
- `api/services/playbook/handlers/ask_customer.ts`: Full rewrite. Deterministic pre-check skips sending if all `required_context` vars already present. Otherwise calls AI with full context, thread history, voice, and previous messages. AI chooses: skip (with extracted values), escalate, or ask (writes contextual message). Legacy literal `message` path preserved.

**Change 3 — New `evaluate` step type**
- `api/services/playbook/types.ts`: Added `EvaluateStep` interface. Added to `PlaybookStep` union.
- `api/services/playbook/handlers/evaluate.ts`: New handler. If required vars present: AI confirms or escalates. If missing: AI detects if info was given in different form (`actually_have_it`) or routes to missing/escalate.
- `api/services/playbook/registry.ts`: Registered `evaluate` handler.
- `api/services/playbook/parser.ts`: Added `evaluate` to `VALID_STEP_TYPES`, added `evaluate` reference validation.
- `api/services/playbook/dry-run.ts`: Handles `evaluate` in the simulation loop (deterministic routing on required_context presence).

**Change 4 — AI-drafted `send_reply`**
- `api/services/playbook/types.ts`: Updated `SendReplyStep` to support `goal`, `reference_context`, `voice_hint` alongside legacy `message` field.
- `api/services/playbook/handlers/send_reply.ts`: Full rewrite. If `goal` is present (or legacy `ai_generate_using_category_voice`): calls AI to draft a contextual reply referencing `reference_context` values. Backward-compat literal `message` path preserved.
- `api/services/playbook/dry-run.ts`: Shows AI-draft description in simulation trace.

**Change 5 — `manual_approval` with input capture**
- `api/services/playbook/types.ts`: Updated `ManualApprovalStep` with `capture_input`, `input_prompt`, `input_context_key`, `draft_preview`.
- `api/services/playbook/handlers/manual_approval.ts`: Includes full config in output so review UI can render it.
- `api/routes/playbooks.ts`: `POST /playbooks/runs/:runId/approve` now accepts optional `{ input: string }` body. Merges input into context under `input_context_key`. List query returns `step_capture_input` and `step_input_prompt` via SQL CASE expression.
- `frontend/src/lib/api.ts`: `PlaybookRun` type includes `step_capture_input` and `step_input_prompt`. `approveRun()` accepts optional `input` string.
- `frontend/src/routes/review/+page.svelte`: When `run.step_capture_input` is true, shows a textarea with the `input_prompt` label. Approve button submits textarea content. Per-run `runInputs` state map.

**Change 6 — Parser updates**
- `api/services/playbook/parser.ts`: Updated `STEP_TYPE_REFERENCE` with new step shapes for `ask_customer` (goal-based), `evaluate` (new), `send_reply` (goal+reference_context preferred), `manual_approval` (capture_input). Added guidance section explaining when to use branch vs evaluate, how to write ask_customer goal, when to use capture_input.

**Docs**
- `docs/PLAYBOOK_ENGINE.md`: Step types table updated with new shapes for all changed step types plus `evaluate`.

### Validation

- `deno check main.ts` passes with 0 errors.
- `svelte-check` passes with 0 new errors (1 pre-existing PUBLIC_API_BASE_URL env var error, 28 pre-existing accessibility warnings).

### Decisions made

- `ask_customer` backward compat: if `goal` is absent, send `message` literally. Allows old playbooks to continue running.
- `send_reply` backward compat: if `message` is a string and `goal` is absent, interpolate and send. If `goal` present, call AI.
- Loop detection uses `_loop_detected` as step_id/step_type in the `playbook_step_executions` table (step_type is TEXT, no constraint). Status is `'failed'`.
- `evaluate` AI confirmation when all required vars present: if AI parse fails, defaults to `satisfied` (fail-open, avoids false escalations).
- `evaluate` missing vars: if AI parse fails, defaults to `missing` (fail-safe, routes to ask step).
- `step_capture_input` and `step_input_prompt` are surfaced via SQL CASE expressions in the runs list query — no schema change needed.

### Open questions / blockers

- Refund playbook needs to be regenerated from the plain-language description in the Phase 5 prompt using the updated parser.
- Tracking, order change, damaged playbooks also need regeneration.
- End-to-end test with the demo thread ("I need a refund") not yet run — requires live Gmail + Sheet.
- `dry-run.ts` `evaluate` case is deterministic (no AI call in dry-run) — the AI confirmation path only runs in real execution.

### Next

1. Regenerate refund playbook from plain-language description via the UI parser.
2. Test end-to-end with the demo email.
3. Regenerate other category playbooks.
4. Monitor for loop detection escalations in production.

---

## 2026-04-13 — Phase 4: Migration and Polish

**Phase**: Phase 4
**Status**: in progress

### What was done

**Task 1 — Implement find_sheet_row handler**
- `api/services/playbook/handlers/find_sheet_row.ts`: Full implementation. Tries each `match_attempt` in order: resolves column letter from `sheet_columns` (by letter or header_name), reads column values via Sheets REST API, calls AI to find the best matching row. Writes `row_number` to context (or null if no match found). Always advances — playbook should branch on `context.row_number != null`.

**Task 2 — Implement update_sheet handler**
- `api/services/playbook/handlers/update_sheet.ts`: Full implementation. Reads row_number from context via `row_var`, resolves each column letter from `sheet_columns`, interpolates `{{variable}}` and `{variable}` placeholders from context, writes each cell via Sheets REST API.

**Task 3 — Sheet rules migration script**
- `api/scripts/migrate_sheet_rules_to_playbooks.ts`: For each active `sheet_rules` row, generates a playbook with `extract → branch → find_sheet_row → branch → update_sheet → complete` steps. Links to the rule's first category. Marks rule as `is_active = false`. Supports `--dry-run` flag. Idempotent (skips already-migrated rules).

**Task 4 — Fix dry-run.ts exhaustive switch narrowing**
- `api/services/playbook/dry-run.ts`: Pre-existing TypeScript error in `default:` case of switch (step narrowed to `never`). Fixed by casting to `{ id?: string; type?: string }`.

**Task 5 — Multi-workspace UI**
- `frontend/src/lib/stores.ts`: Added `workspaceStore` — writable store persisted to localStorage under `selected_workspace_id`.
- `frontend/src/lib/api.ts`: Added `workspaceId` param to `threadsApi.list()` and `categoriesApi.list()`.
- `frontend/src/routes/+layout.svelte`: Workspace selector dropdown in sidebar (only shown when more than 1 workspace exists). Loads workspaces on mount, persists selection via `workspaceStore`.
- `frontend/src/routes/+page.svelte`: Subscribes to `workspaceStore`, reloads threads on workspace switch.
- `frontend/src/routes/playbooks/+page.svelte`: Subscribes to `workspaceStore`, passes workspace_id to API calls.

**Task 6 — Error boundary**
- `frontend/src/routes/+error.svelte`: Global SvelteKit error page. Shows HTTP status code, error message, "Back to Threads" and "Go back" buttons.

**Task 7 — Documentation**
- `docs/CLIENT_GUIDE.md`: How to write a playbook, interpret the thread timeline, handle stuck threads, add categories, use dry-run, use review queue.
- `docs/OPERATIONS.md`: Deployment (Dokploy), rollback, DB inspection queries, Gmail OAuth re-auth, quota limits, migrations, log monitoring.
- `docs/ARCHITECTURE.md`: Canonical architecture reference (stack, data model, step types, inbound email flow, executor loop, handler files, frontend routes, security, known limitations).

### Validation

- `deno check main.ts` passes with 0 errors.
- `svelte-check` passes with 0 errors (28 pre-existing accessibility warnings).
- `find_sheet_row` and `update_sheet` handlers: type-checked individually, no errors.
- Migration script: type-checked, no errors.

### Decisions made

- `find_sheet_row` always advances (never fails), setting `row_number = null` on no match. The playbook branches on `context.row_number != null`. This is more composable than failing the run on no-match.
- `update_sheet` interpolates both `{{var}}` (send_reply style) and `{var}` (parser step reference style) for compatibility with AI-generated steps.
- Sheet rules migration sets created playbooks to `is_active = false` — must be manually reviewed and activated to avoid immediate production impact.
- `workspaceStore` only shows the selector when >1 workspace exists, to avoid UI clutter for single-workspace installs.

### Open questions / blockers

- Category migration: each production category needs a playbook written for it before `categoriseAndDraft` legacy path can be removed. Requires Fabien to write 5 playbooks (tracking, refund, order changes, damaged/wrong, general). Use the playbook editor with dry-run.
- Sheet rules → playbook migration: run `migrate_sheet_rules_to_playbooks.ts --dry-run` first, review, then run without flag. Activate the created playbooks manually after review.
- Legacy `categoriseAndDraft` deletion: blocked until every production category has an active playbook. Do not delete until all categories are covered and monitored for 2+ weeks.
- `013_drop_sheet_rules.sql` migration: blocked until sheet rules have been migrated and the system has run stably for 2 weeks without sheet rules.
- Per-playbook `customer_silence_hours` config still missing from the data model (noted in Phase 3). Add as a migration and executor check in a follow-up.
- Real-time updates (SSE/polling) on review queue and thread detail: not yet implemented.
- Retry buttons on failed step executions: not yet implemented.
- Search on threads page: not yet implemented.

### Next

1. Fabien writes playbooks for each production category using the editor.
2. Run `migrate_sheet_rules_to_playbooks.ts --dry-run` to preview migration, then run it.
3. Activate migrated playbooks one at a time; monitor for 24 hours each.
4. Once all categories have active playbooks and 2 weeks of stable operation: delete legacy path.
5. Schedule `013_drop_sheet_rules.sql` when sheet rules have been cleanly migrated.

---

## YYYY-MM-DD — Initial setup

**Phase**: Setup
**Status**: complete

### What was done
- Added `.github/copilot-instructions.md`, `.github/instructions/*`, `.github/prompts/*`, `.github/agents/*`
- Added `skills/` directory with playbook-step, migration-writer, deno-hono-route, svelte5-page
- Added `.vscode/mcp.json` with Postgres MCP server
- Added `docs/PLAYBOOK_ENGINE.md` as the architecture reference
- Added this file

### Validation
- Verified Copilot picks up instructions: asked "what stack does this use" and got correct answer (Deno/Hono/Postgres/SvelteKit 5)
- Verified slash commands appear: `/phase-0-bleeding`, `/phase-1-cleanup`, etc.
- Verified custom agents appear: `@planner`, `@backend-implementer`, etc.
- Verified Postgres MCP can query the dev DB

### Decisions made
- Dashboard is the source of truth for Gmail labels (one-way sync with surfacing for orphaned labels)
- Strangler-fig migration to playbooks: legacy `categoriseAndDraft` runs alongside playbook engine until Phase 4
- One playbook per category for v1
- Customer silence timeout: 7 days default, configurable per playbook

### Open questions / blockers
- None blocking. Ready to start Phase 0.

### Next
- Run `/phase-0-bleeding` to fix the 5 critical bugs in current system

---

## 2026-04-13 — Phase 3: Playbook UI

**Phase**: Phase 3
**Status**: complete

### What was done

**Task 1 — Parser service**
- `api/services/playbook/parser.ts`: `parsePlaybook(description, workspaceId)` — builds context-aware system prompt (step type reference, workspace sheet context, category list), calls `chatCompletion` with `json_object` response format, validates step types and cross-references (on_reply_goto, if_true/false, on_approve/reject), returns `{ steps, warnings }`.

**Task 2 — Dry-run service**
- `api/services/playbook/dry-run.ts`: `dryRunPlaybook(playbookId, emailContent, workspaceId)` — sandbox execution. Calls AI for `extract` steps (real AI call, no Gmail), simulates branches using real condition eval, captures messages that `ask_customer`/`send_reply` would send, skips sheet writes. Returns `{ finalStatus, context, trace }` with per-step trace entries.

**Task 3 — Playbooks route**
- `api/routes/playbooks.ts`: Full CRUD (`GET/POST /playbooks`, `GET/PUT/DELETE /playbooks/:id`), `POST /playbooks/:id/activate`, `POST /playbooks/:id/deactivate`, `POST /playbooks/:id/dry-run`, `POST /playbooks/parse`.
- Run management: `GET /playbooks/runs` (with thread_id/playbook_id/status filters, includes step_reason via JSONB query), `GET /playbooks/runs/:runId` (with step executions), `POST /playbooks/runs/:runId/approve` (looks up manual_approval step's on_approve, jumps there, calls advanceRun), `POST /playbooks/runs/:runId/reject` (same but on_reject).
- Route registered in `api/main.ts`, services exported in `api/services/playbook/mod.ts`.

**Task 4 — Frontend API client**
- `frontend/src/lib/api.ts`: Added `Playbook`, `PlaybookRun`, `StepExecution`, `DryRunTraceEntry`, `DryRunResult` types. Added `playbooksApi` with all methods: list, get, create, update, delete, parse, dryRun, activate, deactivate, listRuns, getRun, approveRun, rejectRun.

**Task 5 — Playbooks list page**
- `frontend/src/routes/playbooks/+page.svelte`: Table of all playbooks (name, category, version, step count, active, last edited). New Playbook button creates via API and redirects. Duplicate, Activate/Deactivate, Delete actions.

**Task 6 — Playbook editor page**
- `frontend/src/routes/playbooks/[id]/+page.svelte`: Full editor with category selector + name field (top), plain-language textarea + "Generate Steps" button with warning display (left), step pipeline cards with type icons + summaries + move/edit/delete controls (right), save and save-and-activate buttons (bottom).
- Per-step edit modals for all 9 step types: extract (variables list), find_sheet_row (match_attempts), update_sheet (row_var + updates), ask_customer (message + on_reply_goto), branch (condition + if_true + if_false), manual_approval (reason + draft_template + on_approve + on_reject), send_reply (text or AI voice mode), complete (no config), escalate (reason).
- Dry-run modal: paste example email → simulate → shows finalStatus, context bag, full trace with per-step conditions/messages/extracted vars.

**Task 7 — Thread detail observability**
- `frontend/src/routes/threads/[id]/+page.svelte`: Added playbook runs panel. Loads `playbooksApi.listRuns({ thread_id })` alongside thread data. Collapsible run cards show: playbook name/version, status with color dot, current step ID. Expanded view shows: context bag key-value table, step execution log with status, timing, output, AI calls (collapsible).

**Task 8 — Review queue update**
- `frontend/src/routes/review/+page.svelte`: Now loads `waiting_for_human` playbook runs alongside in_review threads. Playbook approvals section groups runs by `step_reason`. Approve button calls `approveRun` (resumes playbook at on_approve step), Reject calls `rejectRun` (goes to on_reject step → typically escalate). Header shows combined count.

**Task 9 — Nav**
- `frontend/src/routes/+layout.svelte`: Added Playbooks link between Categories and Sheet Rules.

### Validation

- `GET /playbooks?workspace_id=1` returns seeded "Tracking Request" playbook — confirmed.
- `POST /playbooks` creates new playbook with id, version=1, is_active=false — confirmed.
- `PUT /playbooks/:id` with changed steps bumps version from 1 → 2 — confirmed.
- `DELETE /playbooks/:id` returns `{ok: true}` — confirmed.
- `GET /playbooks/runs?status=waiting_for_human` returns empty array (none yet) — confirmed.
- Frontend serves with "Playbooks" in nav — confirmed.
- No new TypeScript errors introduced (1 pre-existing env variable check error unrelated to Phase 3).

### Decisions made

- Parser uses "gpt-4o" hardcoded (not workspace model setting) — parser needs best reasoning for step generation.
- Dry-run simulates `find_sheet_row` and `update_sheet` without actually hitting the sheet (returns mock row_number=1), to avoid needing OAuth in testing.
- Approve/reject endpoints look up current `manual_approval` step's `on_approve`/`on_reject` from the playbook steps array — runs don't store these separately.
- Version bumped only if steps JSON actually changed (PUT compares serialized JSON).
- `step_reason` field on runs list is extracted via JSONB query from `playbooks.steps` array inline — avoids separate round trips.

### Open questions / blockers

- Playwright E2E test not implemented yet (MCP tools not available in this session). Manual smoke test confirms routes and frontend renders correctly.
- Parse endpoint requires real OpenAI API key in the container to actually call the AI. Safe to call with an empty key — it will return a 500 from chatCompletion, which surfaces as an error to the client.

### Next

- Run `/phase-4-sheet-integration` to implement `find_sheet_row` and `update_sheet` handlers properly.
- Playwright E2E test for the full playbook create → dry-run → activate → trigger flow.
- Per-playbook `customer_silence_hours` config (currently missing from the data model).

---

## 2026-04-13 — Phase 2: Playbook Engine Foundation

**Phase**: Phase 2
**Status**: complete

### What was done

**Task 1 — Migrations (010, 011, 012)**
- `api/db/migrations/010_playbooks.sql`: `playbooks` table with workspace/category FKs, JSONB steps, version, is_active, updated_at trigger.
- `api/db/migrations/011_playbook_runs.sql`: `playbook_runs` table with thread/playbook FKs, JSONB context bag, status CHECK constraint, indexes on thread and (workspace_id, status).
- `api/db/migrations/012_playbook_step_executions.sql`: `playbook_step_executions` table with run FK, step_id, input/output/error/ai_calls JSONB, status CHECK.

**Task 2 — Step types and executor**
- `api/services/playbook/types.ts`: Full type definitions for all 9 step types, `Playbook`, `PlaybookRun`, `StepExecution`, `RunContext`, `StepResult`, `StepHandler` interface.
- `api/services/playbook/executor.ts`: `advanceRun(runId)` dispatch loop with max-iteration safety, `resumeRun(runId)` for paused runs (handles `waiting_for_customer` via `on_reply_goto`), `startRun(workspaceId, threadId, playbookId)` to create and execute a new run.
- `api/services/playbook/registry.ts`: Maps step_type strings to handler implementations.
- `api/services/playbook/mod.ts`: Barrel export file.

**Task 3 — Handlers (7 implemented, 2 stubs)**
- `handlers/extract.ts`: AI-powered variable extraction from thread transcript using `chatCompletion`.
- `handlers/branch.ts`: Condition evaluator supporting `context.X != null`, `context.X == null`, `context.X` (truthy).
- `handlers/ask_customer.ts`: Sends a reply via Gmail and pauses as `waiting_for_customer`.
- `handlers/send_reply.ts`: Sends a reply with `{{variable}}` template interpolation and advances.
- `handlers/complete.ts`: Marks run as complete.
- `handlers/escalate.ts`: Marks run as failed/escalated.
- `handlers/manual_approval.ts`: Pauses as `waiting_for_human`.
- `handlers/find_sheet_row.ts`: Stub (Phase 4).
- `handlers/update_sheet.ts`: Stub (Phase 4).

**Task 4 — Resume mechanism**
- `api/services/gmail.ts` `ingestMessage`: Before calling `categoriseAndDraft`, checks for an active `playbook_runs` row with `status = 'waiting_for_customer'` on the thread. If found, calls `resumeRun()` instead.

**Task 5 — New-thread routing**
- `api/services/categorisation.ts` `categoriseAndDraft`: After categorisation, checks if the chosen category has an active playbook. If yes, sets category on thread and calls `startRun()` instead of the legacy draft/auto-reply flow. Legacy path untouched for categories without playbooks.

**Task 6 — Test playbook seeded**
- `api/scripts/seed_playbook.ts`: Created "Tracking Request" category (id=5) and playbook (id=1) in workspace 1.
- Playbook steps: extract_1 → branch_1 → (ask_1 or send_1) → complete_1.

### Validation

- All 3 migrations applied: `playbooks`, `playbook_runs`, `playbook_step_executions` tables verified via `\d` in psql.
- API starts cleanly with zero compilation/import errors from the new playbook module.
- Health checks passing continuously (`GET /health 200`).
- Playbook seeded: `SELECT * FROM playbooks` confirms id=1 with correct steps JSONB.
- Legacy `categoriseAndDraft` path still intact for categories without playbooks (no code removed).

### Decisions made

- Branch condition evaluator uses simple regex matching for v1 (`context.X != null`, `context.X == null`, `context.X`). No sandboxed eval. Can extend later.
- `send_reply` supports `{{variable}}` template interpolation in string messages. AI-generated and from_template modes deferred.
- Thread status updated by executor: `complete` → 'replied', `waiting_*` → 'in_review', `failed/escalated` → 'in_review'.
- Max 50 iterations safety valve in executor loop to prevent infinite playbook loops.

### Open questions / blockers

- End-to-end test with real Gmail requires OAuth tokens to be present (user must re-authenticate per Phase 1 note).
- `find_sheet_row` and `update_sheet` are stubs — will be implemented in Phase 4.

### Next

- **User action required**: re-authenticate OAuth if not already done, then send test emails to verify the full tracking playbook flow.
- Run Phase 3: Playbook UI (create/edit playbooks, view run traces, manual approval queue).

---

## 2026-04-13 — Phase 1: Cleanup and Consolidation

**Phase**: Phase 1
**Status**: complete

### What was done

**Task 1 — Consolidate token refresh into `services/google-auth.ts`**
- Created `api/services/google-auth.ts`: single `getGoogleAccessToken(email)` function, AES-256-GCM encrypt/decrypt helpers (`encryptToken`, `decryptToken`).
- Deleted local token refresh from `gmail.ts`, `sheets.ts`, `sheet-rules.ts`. All now import from `google-auth.ts`.
- `GOOGLE_TOKEN_URL` constant deduplicated.

**Task 2 — Consolidate OpenAI calls through `ai.ts`**
- Exported `getModel` and `chatCompletion` from `api/services/ai.ts`.
- Deleted local `getApiKey`, `getModel`, `complete`, `OPENAI_API_URL` from `sheet-rules.ts`. Both call sites (`findMatchingRow`, `resolveAiUpdateValue`) now use `chatCompletion()` from `ai.ts`.

**Task 3 — Encrypt OAuth tokens at rest**
- Created migrations `006_encrypt_oauth_tokens.sql` and `007_drop_plain_oauth_tokens.sql`.
- `google-auth.ts` reads/writes only `access_token_encrypted`/`refresh_token_encrypted` (BYTEA). No plaintext fallback.
- `auth.ts` OAuth callback encrypts both tokens before upsert.
- `ENCRYPTION_KEY` (AES-256, 32 bytes, base64) added to `.env`.
- Backfill/verify script at `api/scripts/encrypt_tokens.ts`.

**Task 4 — Fix OAuth CSRF (state verification)**
- Created migration `008_oauth_states.sql`: `oauth_states(state TEXT PK, created_at TIMESTAMPTZ)`.
- `/auth/google/start`: generates random state, stores in `oauth_states`, includes in redirect URL.
- `/auth/google/callback`: reads state from query, verifies it exists in DB and was created < 10 min ago, deletes it. Rejects with 400 if missing/expired.

**Task 5 — Delete dead code**
- Deleted `api/middleware/error.ts` (`errorMiddleware` had zero callers; `ErrorResponse` type moved to `types/index.ts`).
- Deleted `findRowByValue`, `applyUpdates`, `readThreadsSheet`, `sheetsAppend`, `sheetsPut` from `sheets.ts`.
- Created migration `009_drop_sheet_updates.sql`: drops `sheet_updates` table.
- Fixed `main.ts` import of `ErrorResponse` (now from `types/index.ts`).

### Validation

- API starts cleanly: `[migrate] All migrations are up to date.` and `GET /health 200` continuously.
- `ENCRYPTION_KEY` confirmed present in container (`docker compose exec api sh -c 'echo ENCRYPTION_KEY=$ENCRYPTION_KEY'`).
- `GET /auth/status` returns `{ connected: true, email: "justfabienscoot@gmail.com" }`.
- No remaining references to plaintext `access_token`/`refresh_token` DB columns anywhere in `api/` (grep verified).
- All four deprecated functions removed from `sheets.ts`; no callers existed.

### Decisions made

- DB was already ahead of codebase: plaintext token columns were already dropped, and migrations 006–010 (match_strategy_confidence, sheet_rule_feedback, flows, flow_links, unified_pipeline) already applied. Removed all transition/fallback code entirely rather than adding compatibility shims.
- Migration numbering collision: our new 006–009 files coexist with pre-existing 006_match_strategy_confidence through 010_unified_pipeline. No conflict because `schema_migrations` tracks by full filename, not number prefix.
- `ENCRYPTION_KEY` generated with `openssl rand -base64 32` and written to `.env`. Must be added to Dokploy env before deploying.

### Open questions / blockers

- Existing `oauth_tokens` row has `access_token_encrypted = NULL` and `refresh_token_encrypted = NULL`. The system will throw 401 on any Gmail/Sheets call until the user re-authenticates via Settings → Connect Google Account.

### Next

- **User action required**: re-authenticate via Settings → Connect Google Account (OAuth flow will write encrypted tokens).
- Run Phase 2 (`/phase-2-playbook-engine`): playbook engine — data model, step executor, inbound email resume logic.

---

## 2026-04-13 — Phase 0: Stop the Bleeding

**Phase**: Phase 0
**Status**: complete

### What was done

**Fix 4 — Bounded 429 retry in `sheet-rules.ts` `complete()`**
- Replaced recursive call with a `for` loop (max 3 attempts, exponential backoff: 1s/2s/4s, respects `Retry-After` header).
- File: `api/services/sheet-rules.ts`

**Fix 3 — Transaction wrapper for `categoriseAndDraft` writes**
- Added `transaction` to the `db/client.ts` import in `categorisation.ts`.
- All DB writes (UPDATE category_id, DELETE pending drafts, INSERT draft, UPDATE thread status) now execute in a single atomic transaction.
- AI calls and Gmail send happen *before* the transaction opens (they're slow and must not hold a connection).
- File: `api/services/categorisation.ts`

**Fix 1 — Threads with pending drafts move to `in_review`**
- After inserting a draft with `status='pending'`, the transaction also runs `UPDATE threads SET status = 'in_review'`.
- Covers both the "auto-send failed" and "no token/inbound sender" fallback paths.
- File: `api/services/categorisation.ts`

**Fix 2 — Stop re-categorising threads that already have a category + pending draft**
- Early-return guard at the top of `categoriseAndDraft`: if `thread.category_id IS NOT NULL` AND a `pending` draft exists, return current state immediately.
- For threads categorised but with no pending draft (e.g. customer replied after a sent reply), categorisation still runs normally.
- File: `api/services/categorisation.ts`

**Fix 5 — Gmail label sync: dashboard is source of truth**
- Added `gmailPatch<T>` HTTP helper in `gmail.ts`.
- Pass 1 (categories → Gmail): if a category's linked Gmail label exists but has a different name, rename it via `users.labels.patch`. This propagates category renames to Gmail.
- Pass 2 (Gmail → categories): removed auto-import of unknown Gmail labels. Untracked labels are now logged only. Client must create categories in the dashboard.
- File: `api/services/gmail.ts`

### Validation

- Fix 4: Inspect `complete()` — no recursive calls. Max 3 iterations with exponential backoff.
- Fix 3: Any exception between writes (simulated by throwing inside the transaction callback) results in full rollback. Verified by code review.
- Fix 1: Run `SELECT t.id, t.status, d.status FROM threads t LEFT JOIN drafts d ON d.thread_id = t.id WHERE d.status = 'pending'` after triggering low-confidence categorisation — `t.status` should be `in_review`.
- Fix 2: Send two messages to the same thread in dev — second ingest logs "skipping" and does not change category or draft.
- Fix 5: Rename a category in the dashboard, call `POST /labels/sync` — Gmail label name is updated. Untracked Gmail labels are logged, not imported.

### Decisions made

- Dashboard is the hard source of truth for Gmail labels. Gmail-side renames are surfaced as log warnings, not auto-synced, to avoid surprising the client.
- Auto-send failure falls back to `in_review` (not `new`) — the draft needs review, not re-categorisation.

### Next

- Run Phase 1 (`/phase-1-cleanup`): consolidate token refresh, delete dead code, fix OAuth CSRF, encrypt tokens, migrate `sheet_updates` table.

---
