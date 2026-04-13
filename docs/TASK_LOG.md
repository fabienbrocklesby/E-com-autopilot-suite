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
