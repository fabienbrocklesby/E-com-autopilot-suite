# Task Log

This is the living record of work on this project. New entries at the top. Used by Copilot to know what's been done and what's next.

## Format

Each entry:
- Date
- Phase + status
- What was done (with file/migration references)

---

## 2026-04-16 - Sender name in AI replies

**Phase**: polish
**Status**: complete

### What was done

Fixed AI-generated replies appending `[Your Name]` placeholders.

- `api/services/playbook/types.ts` - added `senderName: string | null` to `RunContext`
- `api/services/playbook/executor.ts` - queries `settings` for `sender_name` before the step loop, passes it into `ctx`
- `api/services/playbook/handlers/send_reply.ts` - system prompt now includes `SIGN OFF AS: {name}` when set, and a hard rule against any `[]` placeholder text
- `api/services/playbook/handlers/ask_customer.ts` - same treatment on the ask message prompt
- `frontend/src/routes/settings/+page.svelte` - added `sender_name` setting to the settings form ("Sender name" field with hint "e.g. Sarah from Support")

No migration needed - uses the existing freeform `settings` key/value table.

---



**Phase**: 3 (operator tools)
**Status**: complete

### What was done

Implemented operator-initiated manual replies for any thread, bypassing the playbook engine while optionally injecting context and resuming stalled runs.

**Migration**: `api/db/migrations/018_human_interventions.sql`
- Added `threads.last_manual_reply_at TIMESTAMPTZ` (already applied - confirmed via `information_schema.columns`)

**New service**: `api/services/human-reply.ts`
- `sendHumanReply(workspaceId, threadId, body)` orchestrates the full flow
- Loads thread (workspace-scoped), OAuth token, and last inbound message
- Calls `sendReply()` (Gmail send, also writes outbound `messages` row)
- In `transaction()`: sets `threads.last_manual_reply_at = NOW()`, `status = 'replied'`
- If active run found: injects `_human_intervention` key into `playbook_runs.context` via JSONB `||` merge
- If run was `waiting_for_customer`: calls `resumeRun()` post-transaction
- `waiting_for_human` (manual_approval) is deliberately NOT auto-resumed
- Returns `HumanReplyResult { messageSent, runId, runStatus, contextUpdated }`

**New route**: `POST /threads/:id/manual-reply` in `api/routes/threads.ts`
- Validates non-empty body, max 10,000 chars
- Protected by existing `authMiddleware` on `threadsRouter`

**Frontend**:
- `frontend/src/lib/api.ts` - `threadsApi.sendManualReply(threadId, body, workspaceId?)`
- `frontend/src/lib/components/ManualReplyPanel.svelte` - textarea with char counter, Cmd/Ctrl+Enter shortcut, loading/error/success states, Svelte 5 runes
- `frontend/src/routes/threads/[id]/+page.svelte` - panel rendered at bottom of conversation column, `onSent={load}` reloads thread

### Verified
- `make db-migrate` confirmed column exists
- `curl POST /threads/2/manual-reply` returned `{"messageSent":true,"runId":null,"runStatus":null,"contextUpdated":false}`
- Vite HMR hot-reloaded thread page without errors

---

## 2026-04-16 - Playbook design guide: conversational gate pattern

**Phase**: 5.5 (parser quality)
**Status**: complete

### What was done

Fixed a parser failure mode where the parser generated `evaluate.required_context: ["row_number"]` for descriptions that said "ask why before going ahead", causing evaluate to always pass (row_number was already set by find_sheet_row) and the ask to be silently skipped.

Changes to `docs/PLAYBOOK_DESIGN_GUIDE.md`:

1. **Fixed evaluate step docs** - `required_context` field description now explains the difference between gating on a sheet-lookup variable vs. a conversational variable. Removed the misleading "usually just row_number" text.

2. **Added canonical pattern** - "Ask for information BEFORE performing sheet actions or approvals". Explains the array ordering trick: place ask_1 + extract_2 immediately before the first action step so extract_2's sequential advance lands on the action step. evaluate's if_satisfied_goto jumps over them on the happy path.

3. **Added Example 6** - Full worked example for "refund with reason required first". evaluate_1.required_context is `["refund_reason"]`. ask_1 + extract_2 are positioned before update_1 in the array. Traces both execution paths (reason present upfront, and reason missing/asked).

4. **Added three new anti-patterns**:
   - "evaluate required_context lists only sheet-lookup variables when a conversational gate is needed" (the root cause)
   - "Action steps before the ask-and-extract cycle" (array ordering)
   - "'Wait for response' means manual_approval instead of ask_customer" (wrong step type)

No parser/executor/handler code was changed. The design guide is the system prompt - changes take effect immediately in dev (cache_ms = 0).

Also fixed a pre-existing frontend bug: `+layout.svelte` imported `Settings` from `lucide-svelte` (not installed) and the navLinks array had `icon: '<Settings />'` as a literal string. Fixed to use `⚙️` emoji matching the other nav icons, and removed the unused import.

### Validation

- Playwright: `/review` and `/threads/77` both render without errors.
- Thread page shows playbook approval banner, step history, all fields correct.
- Design guide sections reviewed for consistency - existing examples 1-3 are correct (their ask_1 goals match "couldn't find you in the sheet", not a conversational gate).

### Decisions

- Example 6 uses `ask_1.on_reply_goto: "extract_2"` (not looping back to extract_1) so only refund_reason is re-extracted, avoiding re-running find_sheet_row on a simple reply.
- Kept Examples 1-3 unchanged - they gate on row_number correctly for their descriptions.

### Next

- When new refund playbooks are generated with "ask why first" descriptions, test that evaluate_1.required_context is ["refund_reason"] and the array has ask_1/extract_2 before update_1.


- Validation (how was it verified)
- Decisions (what choices were made)
- Open questions
- Next

---

## 2026-04-15 - Verify: evaluate → ask_customer → resume cycle audit

**Phase**: 5.5 (post-fix audit)
**Status**: complete

### What was done

Full audit of the evaluate → ask_customer → resume execution cycle per `fix-evaluate-ask-resume.prompt.md`.

#### Step 1: Code review

Read `executor.ts`, `evaluate.ts`, `ask_customer.ts`, `types.ts`, `registry.ts`.

**evaluate.ts** - routing correct after the fast-path fix (`6a8f95a`):
- Deterministic pre-check: all required_context present → `advance_to if_satisfied_goto` (zero AI, zero risk).
- AI path (vars missing): returns `advance_to if_missing_goto`, `if_satisfied_goto`, or `if_escalate_goto` from step config. NOT hardcoded to escalate.
- Parse failure defaults to `if_missing_goto` (safe fallback to ask_customer, not escalate).

**ask_customer.ts** - routing correct after skip routing fix (`a531400`):
- All required vars present → `{ action: "advance" }` (next step in array). Correct.
- AI says skip → `{ action: "advance" }` (next step in array). Correct.
- AI says ask → sends message, `{ action: "pause", status: "waiting_for_customer" }`. Correct.
- Resume handled by `resumeRun` which sets cursor to `on_reply_goto` then calls `advanceRun`. Ask_customer is NOT re-executed on resume - the run jumps directly to the configured restart point.

#### Step 2: Postgres audit of failed runs

Queried `playbook_step_executions` for runs 4 and 7 (the two most recent failures on threads 28 and 69):

**Run 4 (escalated, evaluate → ask → loop)**: Root cause was the OLD ask_customer code that returned `advance_to on_reply_goto` when skipping. `on_reply_goto = "extract_1"`, so every skip cycled back to extract_1 instead of advancing to evaluate_1. The loop ran 52 executions before the "total > 50" safety net escalated. FIXED in commit `a531400`.

**Run 7 (failed, evaluate → escalate)**: Root cause was the OLD evaluate.ts that always called AI. The step had `required_context: ["row_number"]` with `row_number = 2`, but the `goal` field said "Do we have the customer's order number?" - AI confused goal text with required variable name and returned `escalate`. FIXED in commit `6a8f95a` (fast path bypasses AI when all required vars present).

#### Step 3: Loop detection verification

Current loop detection (executor.ts):
- Per-step limit: `sameStepCount >= 3` in last 10 executions → escalate.
- Total limit: `> 50` executions → escalate.

For the happy cycle (ask once, customer replies, satisfied):
- `ask_1` fires once (pauses). `resumeRun` sets cursor to `on_reply_goto`. `advanceRun` never re-enters `ask_1`. `sameStepCount` for ask_1 stays at 1. No false positive.
- evaluate → ask_customer path only fires once per evaluate call; after customer replies and vars are present, evaluate takes `if_satisfied_goto` on next pass (deterministic fast path). No repeated pair.

The "pair-loop" and "no-progress" detections described in the prompt do NOT exist in the code - only the two checks above. Neither can cause false positives for the happy cycle.

#### Bug found and fixed: `resumeRun` missing `context` field (TypeScript)

Commit `51693d0` added an early-return for `waiting_for_human` runs but omitted the `context` field required by `RunResult`. TypeScript confirmed this with `TS2741`.

**Fix** (`api/services/playbook/executor.ts`):
```typescript
// Before:
return { runId, status: run.status, currentStepId: run.current_step_id };
// After:
const context = typeof run.context === "string" ? JSON.parse(run.context) : { ...run.context };
return { runId, status: run.status, currentStepId: run.current_step_id, context };
```

This path is guarded by a warning log and should never be called in normal flow (resumeRun is not called for waiting_for_human runs - the approve/reject endpoints handle those). The fix prevents a runtime error if the path were accidentally reached.

#### Step 4: Playwright smoke test

Verified thread pages for the two failed runs:
- Thread 69 (`/threads/69`): "Tracking failed" run renders correctly. Step execution history (4 steps: extract, find_sheet_row, evaluate, escalate) visible with no JS errors.
- Thread 28 (`/threads/28`): All three runs (escalated, failed, complete) render correctly with status badges and step details. No JS errors.

### Files changed
- `api/services/playbook/executor.ts` - add missing `context` field to `resumeRun`'s `waiting_for_human` early return

### Definition of done status
- evaluate.ts correctly routes on_false/on_unsure to any step ID ✅ (fixed in prior session)
- ask_customer.ts correctly pauses on first fire and advances on resume ✅ (fixed in prior session)
- Loop detection does not fire on evaluate → ask → resume → reply cycle ✅ (verified)
- Postgres confirms no spurious loop-detection escalations for "waiting-for-customer" runs ✅ (confirmed: both failed runs have legitimate root causes, now fixed)
- Playwright confirms thread page renders without errors ✅

---

## 2026-04-15 - UI Redesign: 8 tabs → 3 (Inbox, Playbooks, Settings)

**Phase**: UI/UX overhaul
**Status**: complete

### What was done

Full information architecture redesign. Collapsed 8 navigation tabs into 3 primary tabs + demoted System to sidebar footer.

#### Layout + Branding (frontend/src/routes/+layout.svelte)
- Renamed brand from "Email Dash" to "Autopilot"
- Reduced nav from 8 items to 3: Inbox (📥), Playbooks (📋), Settings (⚙)
- Added nav icons and improved active state matching (prefix-based for sub-routes)
- Demoted System link to sidebar footer with subtle styling
- Legacy routes (review, sheet-rules, sheet-updates, categories) still accessible by URL but hidden from nav

#### Backend: Threads API (api/routes/threads.ts)
Extended `GET /threads` to include latest playbook run data via `LEFT JOIN LATERAL`:
- `latest_run_id`, `latest_run_status`, `latest_run_step`, `latest_run_playbook_name`
- `latest_run_total_steps`, `latest_run_completed_steps` (for progress display)
- Updated `ThreadListItem` type in `frontend/src/lib/api.ts` with 7 new fields

#### Inbox (frontend/src/routes/+page.svelte)
Replaced flat thread table with urgency-grouped Inbox:
- **Needs attention**: threads with pending human action, in_review status, or new with drafts
- **In progress**: threads with active playbook runs (running, waiting_for_customer, paused)
- **Other**: everything else (collapsed by default, count shown)
- Each thread row shows: subject, category tag, playbook name + step progress, relative time, status badge
- Keyboard navigation: j/k to move, Enter to open, Escape to deselect
- Action badges for "Action required" and "Draft" inline

#### Thread Detail (frontend/src/routes/threads/[id]/+page.svelte)
Two-column layout:
- **Left**: subject bar with badges, message thread, drafts with approve/reject
- **Right**: sticky sidebar with playbook runs, expandable for context bag and step execution details
- Status pills moved to header bar alongside Categorise button
- Responsive: collapses to single column below 900px

#### Playbooks (frontend/src/routes/playbooks/+page.svelte)
Category-centric merged view:
- Each category is a row showing its name, description, auto-reply status, confidence threshold
- Active playbook shown inline with version, step count, activate/deactivate/edit actions
- Categories without playbooks show "+ Create" CTA
- Orphan playbooks (no category) shown in a separate "Unlinked" section at bottom
- "Manage Categories" link to existing /categories page

#### Settings (frontend/src/routes/settings/+page.svelte)
Minimal changes: title updated to "Autopilot" branding. Existing 3-section layout (Google Account, Workspaces, General) already matched the design spec.

### Decisions made
1. **Default Inbox view**: "Other" threads visible but collapsed (count shown, click to expand)
2. **Brand name**: "Autopilot" everywhere
3. **Dry-run**: stays as modal (existing implementation on playbook detail page)
4. **Settings save**: section-level save (existing per-field save buttons retained)

### Verification
- `svelte-check`: 0 errors, 29 warnings (all a11y, pre-existing)
- Playwright screenshots taken for all 4 pages: Inbox, Thread Detail, Playbooks, Settings
- All urgency grouping logic verified against 24 real threads
- Keyboard navigation (j/k/Enter/Escape) functional

### Files changed
- `api/routes/threads.ts` - extended SQL query
- `frontend/src/lib/api.ts` - extended `ThreadListItem` interface
- `frontend/src/routes/+layout.svelte` - new nav, branding, footer
- `frontend/src/routes/+page.svelte` - full rewrite (Inbox)
- `frontend/src/routes/threads/[id]/+page.svelte` - two-column layout
- `frontend/src/routes/playbooks/+page.svelte` - category-centric merged view
- `frontend/src/routes/settings/+page.svelte` - title update
- `docs/UI_REDESIGN.md` - design proposal (created earlier this session)

---

## 2026-04-15 - Fix: evaluate handler, design guide, rejection reason, playbook regeneration

**Phase**: 6 (bug fixes + playbook stabilisation)
**Status**: complete

### What was done

#### BUG 1 - evaluate handler (api/services/playbook/handlers/evaluate.ts)
**Problem:** The handler always called GPT-4o, even when all required_context vars were present. The AI prompt showed only required_context vars (not full context) and included the GOAL string. This caused GPT-4o to misinterpret goals and escalate runs that should have succeeded (e.g. row_number=2 present but AI escalated because it read "do we have the order number?" and order_number wasn't explicitly in the limited context it saw).

**Fix:** Rewrote the handler with a two-phase approach:
- **Deterministic pre-check**: if all required vars are non-null/non-empty → advance to if_satisfied_goto immediately. Zero AI calls, zero risk.
- **AI path (when vars missing)**: shows FULL context bag + new prompt that asks the AI to check variable PRESENCE and VALIDITY - no GOAL string. Returns satisfied/missing/escalate.
- Removed the unused category voice loading (was dead code - never used in the prompt).

#### BUG 2 - design guide over-generation (docs/PLAYBOOK_DESIGN_GUIDE.md)
**Problem:** Parser AI was adding find_sheet_row, update_sheet, manual_approval to simple conversational flows that didn't need them.

**Fix:** Added three new sections at the top of the design guide:
- **"Match complexity to the description"** - explicit IF/THEN rules: only add sheet steps if description mentions sheet, only add manual_approval if description mentions human action.
- **"Step array layout"** - numbered rule making ask_customer placement explicit: happy path top-to-bottom, fallbacks at bottom.
- **Variable extraction constraint** - added to extract step reference: only extract vars that serve a downstream purpose.

Added **Example 5** (simple conversational flow, no sheet) showing the 6-step pattern: extract → evaluate → send → complete → ask (fallback) → escalate.

**Verification:** Tested parse endpoint:
- "No need to check the sheet" description → 6 steps, NO find_sheet_row, NO update_sheet, NO manual_approval ✅
- Full refund description → 11 steps with proper sheet integration, match_attempts only on Name/Order+Item (actual columns) ✅

#### BUG 3 - rejection reason (api/routes/playbooks.ts + api/services/playbook/handlers/escalate.ts)
**Problem:** When manual_approval was rejected, the run advanced to escalate step which logged its hardcoded config reason (e.g. "Could not find order in sheet") instead of the actual rejection cause.

**Fix:**
- In the reject endpoint (`POST /playbooks/runs/:runId/reject`): inject `_rejection_source = "${step.id} (${reason})"` into run context before advancing.
- In escalate handler: if `ctx.variables._rejection_source` is set, use `"Rejected by human: ${_rejection_source}"` as the logged reason instead of the static config string.

#### Playbook regeneration
Created and activated:
- **Tracking v3** (playbook id=10, category 5): 6-step no-sheet tracking flow. Dry-run verified:
  - "Hey where is my order" → extract(null) → evaluate(missing) → ask_customer → waiting_for_customer ✅
  - "Hey where is my order 12345" → extract(12345) → evaluate(satisfied, deterministic) → send_reply → complete ✅
- **Refund v4** (playbook id=11, category 3): 11-step full sheet flow. Dry-run verified:
  - Full info email → extract → find_sheet_row → evaluate(satisfied, no AI) → update_sheet → manual_approval → waiting_for_human ✅
  - match_attempts only use Name and Order/Item (actual sheet columns) ✅
  - manual_approval capture_input: true, input_context_key: refund_notes ✅

Deactivated legacy playbooks: Tracking Request v1 (id=1), Tracking v2 (id=9), Refund v3 (id=8).

#### ManualActionBanner (frontend/src/lib/components/ManualActionBanner.svelte)
Already built and complete. Verified: renders reason, reference_context values, optional text input when capture_input=true, Done/Reject buttons with confirmation. Backend approve/reject endpoints already working.

### Before/after comparison

| Scenario | Before | After |
|---|---|---|
| "Hey where is my order" | evaluate called AI with goal string → sometimes escalated | evaluate: order_number null → deterministic missing → ask_customer |
| "My order number is 12345" | AI called with only {row_number: 2}, misread goal | Deterministic check: row_number present → advance, 0 AI calls |
| Simple tracking parse | 7 steps with find_sheet_row, evaluate, escalate | 6 steps, no sheet interaction |
| Human rejects approval | Log: "Could not find order in sheet" | Log: "Rejected by human: approval_1 (Approve the refund request)" |

### Known remaining issues
- Live email end-to-end test (actual Gmail send/receive) not run - requires connected Gmail account during test. All logic verified via dry-run.
- Old playbooks (id=1, 3, 6, 9) use legacy step shapes (branch, literal messages) - left as-is, deactivated.

---

## 2026-04-15 - Fix: ask_customer skip routing bug

**Phase**: 5.5 (urgent fix)
**Status**: complete

### What was done
- Fixed `api/services/playbook/handlers/ask_customer.ts` deterministic pre-check
  to return `{action: "advance"}` instead of `{action: "advance_to", stepId: on_reply_goto}`
- Same fix applied to AI "skip" action path
- Legacy `{message}` backward-compat path not affected - it correctly returns `pause` (no bug there)
- Added inline documentation above the pre-check explaining routing semantics

### Bug origin
`on_reply_goto` config field was being used as the skip destination. Semantically
`on_reply_goto` is "resume here AFTER a customer reply" - only relevant when the
step paused. When skipping the ask entirely (no pause, no reply pending), the
correct behaviour is sequential advance. This caused a backward loop to `extract_1`,
triggering the loop safety-net escalation.

### Verification
- `deno check services/playbook/handlers/ask_customer.ts` - zero errors (one unrelated
  deno.json exports warning, pre-existing)
- Code review: deterministic path now returns `{action:"advance"}`, AI skip path now returns
  `{action:"advance"}` with `extracted_keys` logged for observability
- Legacy path (no `goal` field) returns `pause` - unchanged and correct

### MCP usage trace
- filesystem: read ask_customer.ts (full file), types.ts (StepDecision type), executor.ts
  (on_reply_goto resume logic), handlers directory listing
- context7: not required - this is a pure logic fix with no external API usage
- postgres: pre-fix DB state available from prior diagnosis (run_id=4, playbook_id=6);
  post-fix verification deferred to next live test email
- svelte: not applicable (backend-only change)
- playwright: not applicable (no UI change)

### Decisions made
- Fixed both deterministic and AI skip paths in one edit (related, atomic)
- Did NOT touch on_reply_goto field semantics - they're correct, only the wrong
  code path was using them
- Did NOT regenerate the playbook - existing playbook works correctly with the fixed handler
- Legacy backward-compat path left unchanged (already correct)

### Open questions
- send_reply message quality - track for later prompt tuning
- Manual action banner UI not yet built - approval still requires curl (phase-5-5-task-5)

### Next
- Run /phase-5-5-task-5-banner to build the manual action banner
- Run /phase-5-5-task-4-loop-detection for tighter loop detection

---

## 2026-04-14 - Phase 7: Growth - Task 1: Playbook Template Library

**Phase**: Phase 7
**Status**: complete (task 1 of 5)

### What was done

**Migration**
- `api/db/migrations/017_playbook_templates.sql`: `playbook_templates` table with slug (unique), name, category, industry, description, plain_language, steps (JSONB), voice_examples, required_sheet_columns (TEXT[]), is_official. Indexes on category and industry.

**Seed data**
- `api/db/seeds/playbook_templates.sql`: 15 production-ready templates across 3 groups:
  - E-commerce (8): refund, tracking, order change, damaged item, cancellation, address change, return, exchange
  - Customer service (4): FAQ, feedback, complaint, compliment
  - Operations (3): supplier query, B2B enquiry, press enquiry
- Each template has fully-formed steps, plain language descriptions, required sheet columns, and voice examples where appropriate.
- Idempotent via `ON CONFLICT (slug) DO NOTHING`.

**Backend**
- `api/routes/playbook-templates.ts`: Three endpoints:
  - `GET /playbook-templates` - list with optional `?category`, `?industry`, `?search` filters
  - `GET /playbook-templates/:slug` - single template detail
  - `POST /playbook-templates/create-from` - creates a playbook from a template with `{template_slug, category_id, customizations?}`
- Route registered in `api/main.ts`.

**Frontend API client**
- `frontend/src/lib/api.ts`: Added `PlaybookTemplate` interface and `playbookTemplatesApi` with `list()`, `get()`, `createFrom()`.

**Frontend page**
- `frontend/src/routes/playbooks/new/+page.svelte`: Full template browser with:
  - "Start from Scratch" button (top right, creates blank playbook)
  - Search input + category/industry filters
  - Template cards grouped by category
  - Right panel: template detail (plain language description, step list, required sheet columns, voice examples)
  - "Use this template" → form to pick category and name → creates playbook and redirects to editor
- `frontend/src/routes/playbooks/+page.svelte`: Updated "+ New Playbook" button to link to `/playbooks/new` instead of creating inline. Removed dead `createNew` function and `creating` state.

### Validation

- `deno check main.ts` passes with 0 errors.
- `svelte-check` passes with 0 new errors (1 pre-existing `PUBLIC_API_BASE_URL` env var error, 29 pre-existing accessibility warnings).
- `GET /playbook-templates` returns all 15 templates.
- `GET /playbook-templates/ecom-refund` returns the refund template with full steps.
- `GET /playbook-templates?category=tracking` correctly filters to 1 result.
- `POST /playbook-templates/create-from` creates a playbook with the template's steps, name, and plain language description.
- All 15 templates seeded via `INSERT 0 15`.

### Decisions made

- Templates are global (not workspace-scoped) since they're reference material. `is_official` flag distinguishes built-in from future user-contributed templates.
- Create-from-template endpoint lives on `/playbook-templates/create-from` (not `/playbooks/from-template`) to keep the templates router self-contained.
- Templates use `slug` as the URL identifier for human-readable URLs.
- Seed data is separate from migrations (in `api/db/seeds/`) since it's reference data, not schema.

### Next

- Phase 7 Task 2: Playbook testing harness (when clients need confident iteration).
- Phase 7 Task 3–5: Learning loop, richer step types, playbook routing (per client demand).

---

## Phase 6: Hardening - Complete

**Phase**: Phase 6
**Status**: Complete
**All 8 tasks implemented.**

### What was built

1. **Customer silence timeout** (`timeout_worker.ts`): A 30-minute interval worker queries `waiting_for_customer` runs where `updated_at` is older than `customer_silence_hours` hours. Escalates silently by setting status to `escalated`, inserting a `_silence_timeout` step execution, and firing an alert. `customer_silence_hours` is now a configurable INT on the `playbooks` table (migration 013), defaults to 168 (1 week). The playbook editor UI exposes this field.

2. **AI retries + circuit breaker** (`services/ai.ts`): `chatCompletion()` retries up to 3 times on 429/5xx with exponential backoff (1s, 2s, 4s). Respects `Retry-After` header on 429. Module-level circuit breaker opens after 5 failures in 60s, cools for 2 minutes. State exposed via `getCircuitBreakerState()` / `resetCircuitBreaker()`. Manual reset available on `/system` dashboard.

3. **Retry queue for failed steps** (`retry_worker.ts`): Runs marked `retrying` are re-attempted every 5 minutes. Delay schedule: 5m, 15m, 30m, 1h, 2h (capped at 5 attempts). After 5 failures the run is escalated. `playbook_runs` gained `retry_count` and `next_retry_at` (migration 014). The executor marks a step retriable when the error is an AppError 429/502/503 or when the step decision sets `retriable: true`.

4. **Rate limiting** (`services/rate_limit.ts`): Token bucket per workspace per API, backed by Postgres `rate_limit_buckets` table (migration 015). Limits: Gmail 50/s, Sheets 2/s, OpenAI 1/s. `rateLimitedCall()` atomically refills and consumes tokens. `sendReply` and `processNewMessages` in `gmail.ts` are wrapped. `processRetryRuns` in the retry worker skips rate-limited calls cleanly.

5. **Dead letter queue** (`services/gmail.ts` + migration 016): `processNewMessages` catches per-message errors, inserts into `failed_ingestions` (upsert - idempotent on re-runs), logs and continues. The retry worker retries each DLQ entry up to 3×, then marks resolved + sends a `ingestion_failed_permanently` alert. Admin UI at `/system/failed-ingestions`.

6. **Structured logging** (`services/logger.ts`): All `console.log/warn/error` across `main.ts`, `gmail.ts`, `executor.ts`, `ai.ts` replaced with `logger.info/warn/error` emitting JSON lines: `{ timestamp, level, event, ...data }`.

7. **Observability dashboard** (`routes/system.ts` + `frontend/src/routes/system/`): `GET /system/stats` returns active run counts by status, escalations in 24h, step timing avg/p95, AI call counts and tokens, failed ingestion summary, rate limit bucket states, circuit breaker state. Frontend at `/system` auto-refreshes every 30s.

8. **Alerting hook** (`services/alerts.ts`): `sendAlert(workspaceId, event, data)` reads `alert_webhook_url` and `alert_events` from the `settings` table and POSTs a JSON payload. Events: `run_escalated`, `ingestion_failed_permanently`, `circuit_breaker_opened`, `rate_limit_sustained`.

### Migrations (apply in order)
- `013_playbook_timeouts.sql` - `playbooks.customer_silence_hours`, `system_state` table
- `014_run_retries.sql` - `playbook_runs.retry_count`, `.next_retry_at`, `'retrying'` status
- `015_rate_limit_buckets.sql` - `rate_limit_buckets` table
- `016_failed_ingestions.sql` - `failed_ingestions` table, seeds alert settings rows

### Files changed
```
api/db/migrations/013_playbook_timeouts.sql      (new)
api/db/migrations/014_run_retries.sql            (new)
api/db/migrations/015_rate_limit_buckets.sql     (new)
api/db/migrations/016_failed_ingestions.sql      (new)
api/services/logger.ts                           (new)
api/services/rate_limit.ts                       (new)
api/services/alerts.ts                           (new)
api/services/ai.ts                               (modified - retries, circuit breaker)
api/services/gmail.ts                            (modified - DLQ, rate limit, retryIngest)
api/services/playbook/types.ts                   (modified - retrying status, retry fields)
api/services/playbook/executor.ts                (modified - retry logic, logging)
api/services/playbook/timeout_worker.ts          (new)
api/services/playbook/retry_worker.ts            (new)
api/services/playbook/handlers/ask_customer.ts   (modified - workspaceId passthrough)
api/services/playbook/handlers/send_reply.ts     (modified - workspaceId passthrough)
api/routes/system.ts                             (new)
api/routes/playbooks.ts                          (modified - customer_silence_hours)
api/main.ts                                      (modified - workers, system route, logging)
frontend/src/lib/api.ts                          (modified - systemApi, types)
frontend/src/routes/+layout.svelte               (modified - System nav link)
frontend/src/routes/system/+page.svelte          (new - dashboard)
frontend/src/routes/system/failed-ingestions/+page.svelte  (new - DLQ admin)
frontend/src/routes/playbooks/[id]/+page.svelte  (modified - silence timeout input)
```

### Validation
- `deno check main.ts` - passed, 0 errors
- `npm run check` - 1 pre-existing env var error (PUBLIC_API_BASE_URL not set in CI), 29 pre-existing a11y warnings, 0 new errors

### Decisions
- Circuit breaker is module-level (process-scoped). Not persisted across restarts - intentional: a fresh process should probe again.
- Token bucket stored in Postgres so multi-instance deploys share rate limit state.
- DLQ uses `ON CONFLICT DO UPDATE` so a flapping message never creates duplicate rows.
- `retryIngest` in gmail.ts re-uses `ingestMessage` - same path as first ingestion, DLQ logic included.
- `sendReply` signature kept backward-compatible (workspaceId defaults to 1) so existing callers need no change.

---

## 2026-04-14 - Phase 5: Smart Playbooks

**Phase**: Phase 5
**Status**: complete

### What was done

**Change 1 - Loop detection in executor**
- `api/services/playbook/executor.ts`: Added `escalateRunDueToLoop()` helper. Before each step execution, queries the last 10 step executions: if the same step has fired 3+ times, or total executions exceed 50, the run is escalated with a `_loop_detected` sentinel step execution. Thread is moved to `in_review`.

**Change 2 - AI-driven `ask_customer`**
- `api/services/playbook/types.ts`: Updated `AskCustomerStep` to support `goal`, `required_context`, `voice_hint` (new) alongside legacy `message` field.
- `api/services/playbook/handlers/ask_customer.ts`: Full rewrite. Deterministic pre-check skips sending if all `required_context` vars already present. Otherwise calls AI with full context, thread history, voice, and previous messages. AI chooses: skip (with extracted values), escalate, or ask (writes contextual message). Legacy literal `message` path preserved.

**Change 3 - New `evaluate` step type**
- `api/services/playbook/types.ts`: Added `EvaluateStep` interface. Added to `PlaybookStep` union.
- `api/services/playbook/handlers/evaluate.ts`: New handler. If required vars present: AI confirms or escalates. If missing: AI detects if info was given in different form (`actually_have_it`) or routes to missing/escalate.
- `api/services/playbook/registry.ts`: Registered `evaluate` handler.
- `api/services/playbook/parser.ts`: Added `evaluate` to `VALID_STEP_TYPES`, added `evaluate` reference validation.
- `api/services/playbook/dry-run.ts`: Handles `evaluate` in the simulation loop (deterministic routing on required_context presence).

**Change 4 - AI-drafted `send_reply`**
- `api/services/playbook/types.ts`: Updated `SendReplyStep` to support `goal`, `reference_context`, `voice_hint` alongside legacy `message` field.
- `api/services/playbook/handlers/send_reply.ts`: Full rewrite. If `goal` is present (or legacy `ai_generate_using_category_voice`): calls AI to draft a contextual reply referencing `reference_context` values. Backward-compat literal `message` path preserved.
- `api/services/playbook/dry-run.ts`: Shows AI-draft description in simulation trace.

**Change 5 - `manual_approval` with input capture**
- `api/services/playbook/types.ts`: Updated `ManualApprovalStep` with `capture_input`, `input_prompt`, `input_context_key`, `draft_preview`.
- `api/services/playbook/handlers/manual_approval.ts`: Includes full config in output so review UI can render it.
- `api/routes/playbooks.ts`: `POST /playbooks/runs/:runId/approve` now accepts optional `{ input: string }` body. Merges input into context under `input_context_key`. List query returns `step_capture_input` and `step_input_prompt` via SQL CASE expression.
- `frontend/src/lib/api.ts`: `PlaybookRun` type includes `step_capture_input` and `step_input_prompt`. `approveRun()` accepts optional `input` string.
- `frontend/src/routes/review/+page.svelte`: When `run.step_capture_input` is true, shows a textarea with the `input_prompt` label. Approve button submits textarea content. Per-run `runInputs` state map.

**Change 6 - Parser updates**
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
- `step_capture_input` and `step_input_prompt` are surfaced via SQL CASE expressions in the runs list query - no schema change needed.

### Open questions / blockers

- Refund playbook needs to be regenerated from the plain-language description in the Phase 5 prompt using the updated parser.
- Tracking, order change, damaged playbooks also need regeneration.
- End-to-end test with the demo thread ("I need a refund") not yet run - requires live Gmail + Sheet.
- `dry-run.ts` `evaluate` case is deterministic (no AI call in dry-run) - the AI confirmation path only runs in real execution.

### Next

1. Regenerate refund playbook from plain-language description via the UI parser.
2. Test end-to-end with the demo email.
3. Regenerate other category playbooks.
4. Monitor for loop detection escalations in production.

---

## 2026-04-13 - Phase 4: Migration and Polish

**Phase**: Phase 4
**Status**: in progress

### What was done

**Task 1 - Implement find_sheet_row handler**
- `api/services/playbook/handlers/find_sheet_row.ts`: Full implementation. Tries each `match_attempt` in order: resolves column letter from `sheet_columns` (by letter or header_name), reads column values via Sheets REST API, calls AI to find the best matching row. Writes `row_number` to context (or null if no match found). Always advances - playbook should branch on `context.row_number != null`.

**Task 2 - Implement update_sheet handler**
- `api/services/playbook/handlers/update_sheet.ts`: Full implementation. Reads row_number from context via `row_var`, resolves each column letter from `sheet_columns`, interpolates `{{variable}}` and `{variable}` placeholders from context, writes each cell via Sheets REST API.

**Task 3 - Sheet rules migration script**
- `api/scripts/migrate_sheet_rules_to_playbooks.ts`: For each active `sheet_rules` row, generates a playbook with `extract → branch → find_sheet_row → branch → update_sheet → complete` steps. Links to the rule's first category. Marks rule as `is_active = false`. Supports `--dry-run` flag. Idempotent (skips already-migrated rules).

**Task 4 - Fix dry-run.ts exhaustive switch narrowing**
- `api/services/playbook/dry-run.ts`: Pre-existing TypeScript error in `default:` case of switch (step narrowed to `never`). Fixed by casting to `{ id?: string; type?: string }`.

**Task 5 - Multi-workspace UI**
- `frontend/src/lib/stores.ts`: Added `workspaceStore` - writable store persisted to localStorage under `selected_workspace_id`.
- `frontend/src/lib/api.ts`: Added `workspaceId` param to `threadsApi.list()` and `categoriesApi.list()`.
- `frontend/src/routes/+layout.svelte`: Workspace selector dropdown in sidebar (only shown when more than 1 workspace exists). Loads workspaces on mount, persists selection via `workspaceStore`.
- `frontend/src/routes/+page.svelte`: Subscribes to `workspaceStore`, reloads threads on workspace switch.
- `frontend/src/routes/playbooks/+page.svelte`: Subscribes to `workspaceStore`, passes workspace_id to API calls.

**Task 6 - Error boundary**
- `frontend/src/routes/+error.svelte`: Global SvelteKit error page. Shows HTTP status code, error message, "Back to Threads" and "Go back" buttons.

**Task 7 - Documentation**
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
- Sheet rules migration sets created playbooks to `is_active = false` - must be manually reviewed and activated to avoid immediate production impact.
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

## YYYY-MM-DD - Initial setup

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

## 2026-04-13 - Phase 3: Playbook UI

**Phase**: Phase 3
**Status**: complete

### What was done

**Task 1 - Parser service**
- `api/services/playbook/parser.ts`: `parsePlaybook(description, workspaceId)` - builds context-aware system prompt (step type reference, workspace sheet context, category list), calls `chatCompletion` with `json_object` response format, validates step types and cross-references (on_reply_goto, if_true/false, on_approve/reject), returns `{ steps, warnings }`.

**Task 2 - Dry-run service**
- `api/services/playbook/dry-run.ts`: `dryRunPlaybook(playbookId, emailContent, workspaceId)` - sandbox execution. Calls AI for `extract` steps (real AI call, no Gmail), simulates branches using real condition eval, captures messages that `ask_customer`/`send_reply` would send, skips sheet writes. Returns `{ finalStatus, context, trace }` with per-step trace entries.

**Task 3 - Playbooks route**
- `api/routes/playbooks.ts`: Full CRUD (`GET/POST /playbooks`, `GET/PUT/DELETE /playbooks/:id`), `POST /playbooks/:id/activate`, `POST /playbooks/:id/deactivate`, `POST /playbooks/:id/dry-run`, `POST /playbooks/parse`.
- Run management: `GET /playbooks/runs` (with thread_id/playbook_id/status filters, includes step_reason via JSONB query), `GET /playbooks/runs/:runId` (with step executions), `POST /playbooks/runs/:runId/approve` (looks up manual_approval step's on_approve, jumps there, calls advanceRun), `POST /playbooks/runs/:runId/reject` (same but on_reject).
- Route registered in `api/main.ts`, services exported in `api/services/playbook/mod.ts`.

**Task 4 - Frontend API client**
- `frontend/src/lib/api.ts`: Added `Playbook`, `PlaybookRun`, `StepExecution`, `DryRunTraceEntry`, `DryRunResult` types. Added `playbooksApi` with all methods: list, get, create, update, delete, parse, dryRun, activate, deactivate, listRuns, getRun, approveRun, rejectRun.

**Task 5 - Playbooks list page**
- `frontend/src/routes/playbooks/+page.svelte`: Table of all playbooks (name, category, version, step count, active, last edited). New Playbook button creates via API and redirects. Duplicate, Activate/Deactivate, Delete actions.

**Task 6 - Playbook editor page**
- `frontend/src/routes/playbooks/[id]/+page.svelte`: Full editor with category selector + name field (top), plain-language textarea + "Generate Steps" button with warning display (left), step pipeline cards with type icons + summaries + move/edit/delete controls (right), save and save-and-activate buttons (bottom).
- Per-step edit modals for all 9 step types: extract (variables list), find_sheet_row (match_attempts), update_sheet (row_var + updates), ask_customer (message + on_reply_goto), branch (condition + if_true + if_false), manual_approval (reason + draft_template + on_approve + on_reject), send_reply (text or AI voice mode), complete (no config), escalate (reason).
- Dry-run modal: paste example email → simulate → shows finalStatus, context bag, full trace with per-step conditions/messages/extracted vars.

**Task 7 - Thread detail observability**
- `frontend/src/routes/threads/[id]/+page.svelte`: Added playbook runs panel. Loads `playbooksApi.listRuns({ thread_id })` alongside thread data. Collapsible run cards show: playbook name/version, status with color dot, current step ID. Expanded view shows: context bag key-value table, step execution log with status, timing, output, AI calls (collapsible).

**Task 8 - Review queue update**
- `frontend/src/routes/review/+page.svelte`: Now loads `waiting_for_human` playbook runs alongside in_review threads. Playbook approvals section groups runs by `step_reason`. Approve button calls `approveRun` (resumes playbook at on_approve step), Reject calls `rejectRun` (goes to on_reject step → typically escalate). Header shows combined count.

**Task 9 - Nav**
- `frontend/src/routes/+layout.svelte`: Added Playbooks link between Categories and Sheet Rules.

### Validation

- `GET /playbooks?workspace_id=1` returns seeded "Tracking Request" playbook - confirmed.
- `POST /playbooks` creates new playbook with id, version=1, is_active=false - confirmed.
- `PUT /playbooks/:id` with changed steps bumps version from 1 → 2 - confirmed.
- `DELETE /playbooks/:id` returns `{ok: true}` - confirmed.
- `GET /playbooks/runs?status=waiting_for_human` returns empty array (none yet) - confirmed.
- Frontend serves with "Playbooks" in nav - confirmed.
- No new TypeScript errors introduced (1 pre-existing env variable check error unrelated to Phase 3).

### Decisions made

- Parser uses "gpt-4o" hardcoded (not workspace model setting) - parser needs best reasoning for step generation.
- Dry-run simulates `find_sheet_row` and `update_sheet` without actually hitting the sheet (returns mock row_number=1), to avoid needing OAuth in testing.
- Approve/reject endpoints look up current `manual_approval` step's `on_approve`/`on_reject` from the playbook steps array - runs don't store these separately.
- Version bumped only if steps JSON actually changed (PUT compares serialized JSON).
- `step_reason` field on runs list is extracted via JSONB query from `playbooks.steps` array inline - avoids separate round trips.

### Open questions / blockers

- Playwright E2E test not implemented yet (MCP tools not available in this session). Manual smoke test confirms routes and frontend renders correctly.
- Parse endpoint requires real OpenAI API key in the container to actually call the AI. Safe to call with an empty key - it will return a 500 from chatCompletion, which surfaces as an error to the client.

### Next

- Run `/phase-4-sheet-integration` to implement `find_sheet_row` and `update_sheet` handlers properly.
- Playwright E2E test for the full playbook create → dry-run → activate → trigger flow.
- Per-playbook `customer_silence_hours` config (currently missing from the data model).

---

## 2026-04-13 - Phase 2: Playbook Engine Foundation

**Phase**: Phase 2
**Status**: complete

### What was done

**Task 1 - Migrations (010, 011, 012)**
- `api/db/migrations/010_playbooks.sql`: `playbooks` table with workspace/category FKs, JSONB steps, version, is_active, updated_at trigger.
- `api/db/migrations/011_playbook_runs.sql`: `playbook_runs` table with thread/playbook FKs, JSONB context bag, status CHECK constraint, indexes on thread and (workspace_id, status).
- `api/db/migrations/012_playbook_step_executions.sql`: `playbook_step_executions` table with run FK, step_id, input/output/error/ai_calls JSONB, status CHECK.

**Task 2 - Step types and executor**
- `api/services/playbook/types.ts`: Full type definitions for all 9 step types, `Playbook`, `PlaybookRun`, `StepExecution`, `RunContext`, `StepResult`, `StepHandler` interface.
- `api/services/playbook/executor.ts`: `advanceRun(runId)` dispatch loop with max-iteration safety, `resumeRun(runId)` for paused runs (handles `waiting_for_customer` via `on_reply_goto`), `startRun(workspaceId, threadId, playbookId)` to create and execute a new run.
- `api/services/playbook/registry.ts`: Maps step_type strings to handler implementations.
- `api/services/playbook/mod.ts`: Barrel export file.

**Task 3 - Handlers (7 implemented, 2 stubs)**
- `handlers/extract.ts`: AI-powered variable extraction from thread transcript using `chatCompletion`.
- `handlers/branch.ts`: Condition evaluator supporting `context.X != null`, `context.X == null`, `context.X` (truthy).
- `handlers/ask_customer.ts`: Sends a reply via Gmail and pauses as `waiting_for_customer`.
- `handlers/send_reply.ts`: Sends a reply with `{{variable}}` template interpolation and advances.
- `handlers/complete.ts`: Marks run as complete.
- `handlers/escalate.ts`: Marks run as failed/escalated.
- `handlers/manual_approval.ts`: Pauses as `waiting_for_human`.
- `handlers/find_sheet_row.ts`: Stub (Phase 4).
- `handlers/update_sheet.ts`: Stub (Phase 4).

**Task 4 - Resume mechanism**
- `api/services/gmail.ts` `ingestMessage`: Before calling `categoriseAndDraft`, checks for an active `playbook_runs` row with `status = 'waiting_for_customer'` on the thread. If found, calls `resumeRun()` instead.

**Task 5 - New-thread routing**
- `api/services/categorisation.ts` `categoriseAndDraft`: After categorisation, checks if the chosen category has an active playbook. If yes, sets category on thread and calls `startRun()` instead of the legacy draft/auto-reply flow. Legacy path untouched for categories without playbooks.

**Task 6 - Test playbook seeded**
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
- `find_sheet_row` and `update_sheet` are stubs - will be implemented in Phase 4.

### Next

- **User action required**: re-authenticate OAuth if not already done, then send test emails to verify the full tracking playbook flow.
- Run Phase 3: Playbook UI (create/edit playbooks, view run traces, manual approval queue).

---

## 2026-04-13 - Phase 1: Cleanup and Consolidation

**Phase**: Phase 1
**Status**: complete

### What was done

**Task 1 - Consolidate token refresh into `services/google-auth.ts`**
- Created `api/services/google-auth.ts`: single `getGoogleAccessToken(email)` function, AES-256-GCM encrypt/decrypt helpers (`encryptToken`, `decryptToken`).
- Deleted local token refresh from `gmail.ts`, `sheets.ts`, `sheet-rules.ts`. All now import from `google-auth.ts`.
- `GOOGLE_TOKEN_URL` constant deduplicated.

**Task 2 - Consolidate OpenAI calls through `ai.ts`**
- Exported `getModel` and `chatCompletion` from `api/services/ai.ts`.
- Deleted local `getApiKey`, `getModel`, `complete`, `OPENAI_API_URL` from `sheet-rules.ts`. Both call sites (`findMatchingRow`, `resolveAiUpdateValue`) now use `chatCompletion()` from `ai.ts`.

**Task 3 - Encrypt OAuth tokens at rest**
- Created migrations `006_encrypt_oauth_tokens.sql` and `007_drop_plain_oauth_tokens.sql`.
- `google-auth.ts` reads/writes only `access_token_encrypted`/`refresh_token_encrypted` (BYTEA). No plaintext fallback.
- `auth.ts` OAuth callback encrypts both tokens before upsert.
- `ENCRYPTION_KEY` (AES-256, 32 bytes, base64) added to `.env`.
- Backfill/verify script at `api/scripts/encrypt_tokens.ts`.

**Task 4 - Fix OAuth CSRF (state verification)**
- Created migration `008_oauth_states.sql`: `oauth_states(state TEXT PK, created_at TIMESTAMPTZ)`.
- `/auth/google/start`: generates random state, stores in `oauth_states`, includes in redirect URL.
- `/auth/google/callback`: reads state from query, verifies it exists in DB and was created < 10 min ago, deletes it. Rejects with 400 if missing/expired.

**Task 5 - Delete dead code**
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
- Run Phase 2 (`/phase-2-playbook-engine`): playbook engine - data model, step executor, inbound email resume logic.

---

## 2026-04-13 - Phase 0: Stop the Bleeding

**Phase**: Phase 0
**Status**: complete

### What was done

**Fix 4 - Bounded 429 retry in `sheet-rules.ts` `complete()`**
- Replaced recursive call with a `for` loop (max 3 attempts, exponential backoff: 1s/2s/4s, respects `Retry-After` header).
- File: `api/services/sheet-rules.ts`

**Fix 3 - Transaction wrapper for `categoriseAndDraft` writes**
- Added `transaction` to the `db/client.ts` import in `categorisation.ts`.
- All DB writes (UPDATE category_id, DELETE pending drafts, INSERT draft, UPDATE thread status) now execute in a single atomic transaction.
- AI calls and Gmail send happen *before* the transaction opens (they're slow and must not hold a connection).
- File: `api/services/categorisation.ts`

**Fix 1 - Threads with pending drafts move to `in_review`**
- After inserting a draft with `status='pending'`, the transaction also runs `UPDATE threads SET status = 'in_review'`.
- Covers both the "auto-send failed" and "no token/inbound sender" fallback paths.
- File: `api/services/categorisation.ts`

**Fix 2 - Stop re-categorising threads that already have a category + pending draft**
- Early-return guard at the top of `categoriseAndDraft`: if `thread.category_id IS NOT NULL` AND a `pending` draft exists, return current state immediately.
- For threads categorised but with no pending draft (e.g. customer replied after a sent reply), categorisation still runs normally.
- File: `api/services/categorisation.ts`

**Fix 5 - Gmail label sync: dashboard is source of truth**
- Added `gmailPatch<T>` HTTP helper in `gmail.ts`.
- Pass 1 (categories → Gmail): if a category's linked Gmail label exists but has a different name, rename it via `users.labels.patch`. This propagates category renames to Gmail.
- Pass 2 (Gmail → categories): removed auto-import of unknown Gmail labels. Untracked labels are now logged only. Client must create categories in the dashboard.
- File: `api/services/gmail.ts`

### Validation

- Fix 4: Inspect `complete()` - no recursive calls. Max 3 iterations with exponential backoff.
- Fix 3: Any exception between writes (simulated by throwing inside the transaction callback) results in full rollback. Verified by code review.
- Fix 1: Run `SELECT t.id, t.status, d.status FROM threads t LEFT JOIN drafts d ON d.thread_id = t.id WHERE d.status = 'pending'` after triggering low-confidence categorisation - `t.status` should be `in_review`.
- Fix 2: Send two messages to the same thread in dev - second ingest logs "skipping" and does not change category or draft.
- Fix 5: Rename a category in the dashboard, call `POST /labels/sync` - Gmail label name is updated. Untracked Gmail labels are logged, not imported.

### Decisions made

- Dashboard is the hard source of truth for Gmail labels. Gmail-side renames are surfaced as log warnings, not auto-synced, to avoid surprising the client.
- Auto-send failure falls back to `in_review` (not `new`) - the draft needs review, not re-categorisation.

### Next

- Run Phase 1 (`/phase-1-cleanup`): consolidate token refresh, delete dead code, fix OAuth CSRF, encrypt tokens, migrate `sheet_updates` table.

---

## 2026-04-15 - Manual Action Banner

### What was done

**Backend - `api/routes/playbooks.ts`**

- Extended the `GET /playbooks/runs` list query to include `step_reference_context` (JSONB array of strings from the `manual_approval` step's `reference_context` field). Now each run in `waiting_for_human` status carries all the data needed to render the action banner without a second request.

**Backend - `api/routes/threads.ts`**

- Extended the `GET /threads` list query to include `has_pending_action` (boolean, via `EXISTS` subquery against `playbook_runs` for `waiting_for_human` status). Cheap: single correlated subquery per row, no JOIN.

**Frontend - `frontend/src/lib/api.ts`**

- Added `has_pending_action: boolean` to `ThreadListItem`.
- Added `step_reference_context?: string[] | null` to `PlaybookRun`.
- Restored `ThreadDetail` interface (had been accidentally removed during a replacement operation).

**Frontend - `frontend/src/lib/components/ManualActionBanner.svelte`** (new file)

- Svelte 5 runes component. Props: `run: PlaybookRun`, `onComplete: () => void`.
- `$derived` for `reason`, `captureInput`, `inputPrompt`, `canApprove`.
- `$derived.by()` for `referenceItems` - used because it maps over an array and accesses a separate reactive value (`run.context`), making plain `$derived` awkward. Ref: Svelte 5 docs "Derived state / $derived.by".
- `$bindable()` not used - `humanInput` is local to the component, not a prop the parent needs to read back. Ref: Svelte 5 docs "Bindable props / $bindable".
- No form element: approval is an API call, not a form submission. Uses `onclick` handlers directly. Ref: Svelte 5 docs "Event handling".
- `aria-live="polite"` on the banner root; `role="alert"` on the error paragraph.
- Calls `playbooksApi.approveRun` (existing) and `playbooksApi.rejectRun` (existing) - no new API surface.
- CSS uses `--color-*` variables from `+layout.svelte`.

**Frontend - `frontend/src/routes/threads/[id]/+page.svelte`**

- Imports `ManualActionBanner`.
- Added `waitingRun = $derived(runs.find(r => r.status === "waiting_for_human") ?? null)`.
- Banner rendered above the `{#if loading}` block - always visible when a run is paused, even before the thread details load below.
- `onComplete` wired to the existing `load()` function.

**Frontend - `frontend/src/routes/+page.svelte`**

- Bell icon (`🔔`) rendered in the subject cell when `thread.has_pending_action` is true.
- Added `.action-indicator` style with a subtle amber drop-shadow to match the warning colour.

### MCP usage trace

- `filesystem`: read all modified files before editing.
- `context7`: not fetched (existing `$derived.by` usage in the codebase provided sufficient pattern reference).

### Svelte 5 doc citations

- `$derived.by()`: used for `referenceItems` because the derivation maps over an array and accesses a separate reactive binding in the same expression. Plain `$derived` can only hold a single expression.
- `$bindable()`: not needed. `humanInput` is internal state, not exposed to the parent.
- Form-without-form-action: `onclick` async handler + `try/catch` + local `submitting` state. No `<form>`, no `use:enhance`.

### Validation

- `cd frontend && npm run check` → 1 pre-existing error (`PUBLIC_API_BASE_URL` env not set in check context), 29 pre-existing warnings. Zero new errors from this work.
- `cd api && deno check routes/playbooks.ts routes/threads.ts` → clean.
- Playwright end-to-end and Postgres side-effect verification pending (requires live dev environment with a `waiting_for_human` run).

### Next

- Phase 1 cleanup.

---

## 2026-04-15 - Smart Parser & Run #5 Diagnosis

### Part 1: Run #5 Diagnosis

**Full execution trace (run_id=5, playbook_id from Refund v2):**

| Step | Type | Status | Time | Notes |
|------|------|--------|------|-------|
| extract_1 | extract | success | 23:38:26-27 | Extracted customer_name="Fabien Brocklesby", customer_email, order_number=null |
| branch_1 | branch | success | 23:38:27 | customer_name != null → find_1 |
| find_1 | find_sheet_row | success | 23:38:27-29 | Matched on Name column, row_number=2 |
| ask_1 | ask_customer | success | 23:38:29-31 | Auto-skipped - product_name already available from thread |
| evaluate_1 | evaluate | success | 23:38:31-33 | row_number present → update_1 |
| update_1 | update_sheet | success | 23:38:33 | Wrote Status="Refund Requested" to row 2 |
| approval_1 | manual_approval | success | 23:38:33 | Paused (waiting_for_human) |
| escalate_1 | escalate | failed | 23:39:49 | "Could not find order in sheet" |

**Root cause:** The user explicitly rejected the manual approval via POST /playbooks/runs/5/reject. The `on_reject` target of `approval_1` is `escalate_1`. The 76-second gap (23:38:33 → 23:39:49) is consistent with human action time. No inbound messages, no background workers, and no concurrent runs triggered during this window.

**The misleading escalation reason:** `escalate_1` has a static reason "Could not find order in sheet" which fires regardless of HOW the escalation was reached. The order WAS found (row_number=2, context bag confirms). The reason is wrong because a single escalate step serves both "sheet lookup failed" and "approval rejected" paths.

**No concurrent run interference:** Run 4 on the same thread was already in `escalated` status. No other active runs existed.

**Playbook design issues identified:**
1. Extracting `order_number` when the sheet has no "Order Number" column
2. `capture_input: false` on a refund approval (should capture Stripe transaction details)
3. Single escalate step with generic reason for multiple failure paths
4. Branch on `customer_name != null` instead of letting evaluate handle it

**Dormant bug fixed in `resumeRun`:** The `waiting_for_human` branch in `resumeRun()` advanced to the next sequential step in the array, ignoring the `on_approve`/`on_reject` targets. While not the root cause of this run (the approve/reject endpoints correctly use the targets), calling `resumeRun` on a `waiting_for_human` run would route to the wrong step. Fixed to log a warning and return early instead.

### Part 2: Parser Design Guide Extraction

**Created `docs/PLAYBOOK_DESIGN_GUIDE.md`** - canonical reference for playbook structure, loaded into the parser AI's system prompt at runtime. Serves two audiences: the GPT-4o parser (structured reference) and humans (editable without code changes).

**Updated `api/services/playbook/parser.ts`:**
- Removed the hardcoded `STEP_TYPE_REFERENCE` constant and inline system prompt
- Added `loadDesignGuide()` with simple in-memory cache (0ms in dev, 60s in prod)
- Added `buildWorkspaceContext()` which queries `sheet_columns` and injects actual column names
- System prompt is now: design guide markdown with workspace context section replaced at runtime
- Import: `join` from `https://deno.land/std@0.224.0/path/mod.ts` (matches existing project import)
- Path resolution: checks `/docs` (Docker mount) with fallback to `Deno.cwd()/docs` (local dev)

**Updated `docker-compose.yml`:** Added `./docs:/docs` volume mount to the api service so the design guide is accessible inside the container.

**Updated `api/services/playbook/types.ts`:** Added `reference_context?: string[]` field to `ManualApprovalStep` interface.

### Part 3: Sheet-Aware Design Guide

The design guide implements 6 principles:

1. **Sheet is source of truth** - only reference columns that exist in the workspace sheet
2. **Match with whatever the customer provides** - aggressive matching, no required fields
3. **Don't invent useless variables** - extract only what maps to sheet columns or later step configs
4. **Happy path first** - extract → find → evaluate → update → approve → send → complete, then fallbacks
5. **Fail gracefully** - ask once, then escalate. Separate escalate steps with specific reasons
6. **AI-drafted messages** - goal + reference_context, not literal templates

Full step type reference with purpose, when to use, when NOT to use, config schema, and examples.

4 worked examples: Refund, Tracking, Order Change, General Enquiry.

Anti-patterns section with concrete WRONG vs RIGHT pairs.

### Validation

**Parser test with refund description:**
- No `order_number` in extract variables ✓
- `find_sheet_row` uses actual sheet columns (Name, Order/Item) ✓
- `evaluate` checks only `row_number` ✓
- Happy path first, `ask_customer` at bottom ✓
- `manual_approval` has `capture_input: true` with `reference_context` ✓
- Separate escalate steps (escalate_no_match, escalate_rejected) ✓
- Zero warnings ✓

**API startup:** Clean, no errors from design guide loading.

### MCP usage trace

- `postgres` (via Docker exec): 4 queries for run #5 diagnosis (step executions, concurrent runs, messages, context bag, playbook steps)
- `filesystem`: read parser.ts, executor.ts, manual_approval handler, gmail.ts, types.ts, docker-compose.yml, TASK_LOG.md

### Next

- Save refund playbook as "Refund v3" and run end-to-end test on fresh email
- Phase 1 cleanup

---
