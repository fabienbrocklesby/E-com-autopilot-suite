# e-com-autopilot-suite — Copilot project context

You are working on an email automation dashboard for an e-commerce client. This file is loaded into every chat. Read it before doing anything.

## What this product does

A dashboard that sits between Gmail + Google Sheets and the client's manual workflow. Inbound emails are categorised by AI, then either auto-replied, queued for manual review with a draft, or paused while waiting for more info. The client uses Gmail + Sheets as source of truth. The system updates Sheets when threads progress (e.g. mark refund status, log reasons).

The current implementation has working primitives (categorisation, auto-reply, sheet rules) but they're disconnected. We are migrating to a **playbook engine** where each category owns a multi-step flow with isolated per-thread memory. See `docs/PLAYBOOK_ENGINE.md` for the full architecture.

## Stack

- **Backend**: Deno + Hono (TypeScript). NOT Go, despite some older docs saying so.
- **Database**: Postgres 16. Migrations in `api/db/migrations/*.sql`, applied sequentially via `api/db/migrate.ts`.
- **Frontend**: SvelteKit 5 with runes (`$state`, `$derived`, `$effect`). NOT Svelte 4 syntax.
- **Deployment**: Docker Compose locally, Dokploy on a VPS in production.
- **External APIs**: Gmail REST v1 (raw HTTP, no SDK), Sheets REST v4 (raw HTTP), OpenAI Chat Completions.
- **Auth**: Bearer token on a single `API_SECRET` env var. No per-user sessions yet.

## Architecture vision (the thing we're building toward)

1. **Categories own playbooks.** A playbook is a sequence of steps (extract, find_sheet_row, update_sheet, ask_customer, branch, manual_approval, send_reply, complete, escalate).
2. **Each thread runs a playbook instance** with isolated context (variable bag), current step cursor, and status.
3. **Inbound emails resume paused runs** instead of re-categorising. Re-categorisation only happens for new threads.
4. **The client writes playbooks in plain language**, the AI parses them into structured steps, and the client tunes individual steps in a UI.
5. **Sheet rules eventually become a step type**, not a separate concept.

We are NOT there yet. We are building toward this in 5 phases. Current phase is tracked in `docs/TASK_LOG.md`.

## Critical conventions

### Backend (api/)

- **All Postgres writes that span multiple statements MUST be wrapped in `transaction()`** from `db/client.ts`. The current `categoriseAndDraft` is the cautionary tale.
- **Token refresh logic is currently duplicated 3 times.** Phase 1 consolidates this into `services/google-auth.ts`. Don't add a 4th copy.
- **OpenAI calls go through `services/ai.ts` `chatCompletion()`**. Don't write new wrappers. The `complete()` in `sheet-rules.ts` is being removed.
- **Workspace scoping**: every query that touches workspace-owned data MUST filter by `workspace_id`. There is no row-level security in Postgres yet.
- **Fire-and-forget is a smell.** Currently `evaluateRules` and `applyLabel` are `.catch()`-and-forget. New code should either await properly or queue the work explicitly. Phase 2 introduces a real job runner.

### Frontend (frontend/)

- **SvelteKit 5 syntax only.** Use `$state`, `$derived`, `$effect`, `$props`. Never `let x = ...` for reactive state, never `$:` for reactivity.
- **API client lives in `src/lib/api.ts`.** Don't fetch directly from components.
- **Stores in `src/lib/stores.ts`.** Use `writable` from `svelte/store` for now (we're not migrating stores to runes yet).
- **No workspace selector exists yet.** Hardcoded to workspace_id=1. Don't add complexity assuming multi-workspace UI until Phase 4.

### Database (api/db/migrations/)

- **Migrations are append-only.** Never edit a previously-applied migration. New file: `00N_description.sql` where N is the next number.
- **Every migration must be safe to apply on production data.** No destructive changes without an explicit migration plan in the PR.
- **CHECK constraints over enums.** We use `TEXT CHECK (col IN (...))` not Postgres ENUM types — easier to evolve.

## Known issues we're actively fixing

These are bugs in the current code. If you encounter them, fix or flag, don't propagate:

1. **Threads with pending drafts stay at status `new` instead of moving to `in_review`.** Fixed in Phase 0.
2. **Re-categorisation runs on every inbound message,** clobbering existing categories and drafts. Fixed in Phase 0 / 2.
3. **Recursive 429 retry in `sheet-rules.ts` `complete()`.** Stack overflow risk. Fixed in Phase 1.
4. **OAuth state parameter generated but never verified.** CSRF hole. Phase 1.
5. **OAuth tokens stored in plain text.** Phase 1 adds at-rest encryption.
6. **`sheet_updates` table receives no writes.** Dead. Phase 1 drops it.
7. **`errorMiddleware`, `applyUpdates`, `readThreadsSheet`, `findRowByValue`, `sheetsAppend`** are all dead code. Phase 1 deletes.

## How to be useful

- **Read `docs/PLAYBOOK_ENGINE.md` before any Phase 2+ work.** It defines the data model and step interface.
- **Read `docs/TASK_LOG.md` before starting work** to know what's done, in flight, and blocked.
- **Update `docs/TASK_LOG.md` when you finish a meaningful chunk.** This is how state survives between Copilot sessions.
- **Use the Postgres MCP to inspect real schema and data** rather than guessing.
- **Use context7 MCP for framework docs** (Hono, SvelteKit 5, Deno, Postgres). Don't rely on training data for these — they move fast.
- **Use the svelte MCP for SvelteKit-specific questions.** It knows the runes API better than your training data.
- **Use playwright MCP to verify UI changes** end to end before declaring done.

## Communication style

The user (Fabien) is a founder, moves fast, hates fluff. When responding:

- Skip preamble. Don't say "I'll help you with that!"
- State what you're going to do, do it, report what happened.
- If something is risky or ambiguous, flag it and ask. Don't barrel through.
- Use code blocks for code, prose for prose. Don't bullet everything.
- Avoid em dashes in conversational responses. Code comments and docs are fine.
- If you find a bug while doing something else, surface it. Don't silently fix and move on.

## When to refuse / push back

- If asked to add a 4th token refresh implementation: refuse, point at Phase 1.
- If asked to add a synchronous Sheet write inside the request handler: push back, suggest the job queue path.
- If asked to put business logic in a Svelte component: push back, propose a backend route or service.
- If asked to skip a transaction wrapper for "speed": refuse.
