# E-com Autopilot Suite

An email automation dashboard for e-commerce stores. Inbound emails are categorised by AI, then processed via playbooks: multi-step flows that extract info, look up sheet rows, ask customers questions, update Google Sheets, hold for human approval, and send contextual replies.

## Stack

- **Backend**: Deno + Hono (TypeScript). NOT Go.
- **Database**: Postgres 16. Migrations in `api/db/migrations/*.sql`, sequential, append-only.
- **Frontend**: SvelteKit 5 with runes (`$state`, `$derived`, `$effect`, `$props`). NOT Svelte 4.
- **External APIs**: Gmail REST v1, Google Sheets REST v4, OpenAI Chat Completions (GPT-4o).
- **Deployment**: Docker Compose locally, Dokploy on VPS in production.
- **Auth**: Bearer token via `API_SECRET` env var. No per-user sessions.

## Architecture

Categories own playbooks. A playbook is a sequence of steps the AI executes per-thread. Each thread gets an isolated run with its own context bag (variables), step cursor, and status. See `docs/PLAYBOOK_ENGINE.md` for the full spec.

The playbook parser reads `docs/PLAYBOOK_DESIGN_GUIDE.md` at runtime and injects the workspace's actual sheet columns before sending to GPT-4o. This design guide is the single source of truth for how playbooks should be structured. Edit the markdown to change playbook generation behavior, no code changes needed.

Step types: extract, find_sheet_row, update_sheet, ask_customer, evaluate, branch, manual_approval, send_reply, complete, escalate.

## MCP servers available

You have postgres, filesystem, playwright, context7, and svelte MCP servers. Use them:

- **Before using ANY library or framework API**: fetch current docs via context7. Don't write code from memory.
- **Before any database work**: inspect current schema and data via postgres MCP.
- **Before any frontend work**: check svelte MCP for current SvelteKit 5 runes API.
- **After any change**: verify via postgres (data state) and playwright (UI state).
- **Before editing any file**: read it first via filesystem. Don't assume contents.

## Critical conventions

### Backend (api/)

- All multi-statement DB writes MUST use `transaction()` from `db/client.ts`.
- Every query on workspace-owned data MUST filter by `workspace_id`.
- OpenAI calls go through `chatCompletion` in `services/ai.ts`. No other wrappers.
- Google API calls go through `getGoogleAccessToken` in `services/google-auth.ts`.
- No fire-and-forget without explicit justification.
- Routes are thin. Logic lives in services.
- Throw `AppError(message, status)` for known errors.

### Frontend (frontend/)

- SvelteKit 5 runes ONLY. No `let x = ...` for reactive state, no `$:`, no `export let`.
- Use `$state`, `$derived`, `$effect`, `$props`, `$bindable`.
- API calls through `src/lib/api.ts`, never direct fetch.
- CSS variables from `+layout.svelte`. Component-scoped `<style>` blocks. No Tailwind.
- Loading/error/content states on every data-fetching page.

### Migrations (api/db/migrations/)

- Append-only. Never edit applied migrations. Next file: `0NN_description.sql`.
- `BEGIN; ... COMMIT;` wrapper. `IF NOT EXISTS` on creates.
- Explicit `ON DELETE` on foreign keys. `workspace_id` on workspace-owned tables.
- `created_at` + `updated_at` + trigger. `TEXT CHECK` over Postgres ENUM. JSONB over JSON.

## Known issues to be aware of

- Some old playbooks (v1, v2) still use legacy step shapes (literal `message` in ask_customer, `branch` instead of `evaluate`). New playbooks should use the new shapes.
- Shopify Admin API order lookups are not implemented; order data still comes from Google Sheets only. A future `find_order` step can write into `threads.brief.facts` the same way `find_sheet_row` does today.
- The sheet-rules system (`/sheet-rules`, `/sheet-updates`) has not been migrated into playbooks yet. It still runs as a separate primitive alongside the playbook engine.
- `categories.name` has no per-workspace unique constraint. This is a latent multi-tenant bug, harmless today because the app runs single-tenant.
- Customer attachments are marked in the transcript (`[attachment: filename]`) but their content is not read or understood by the AI.

## Code quality bar

- Senior-level: clear naming, single responsibility, explicit error handling.
- Type-safe: no `any` without justification. No `as` casts without comments.
- Documented: inline comments explain WHY, not WHAT. Cite docs when using non-obvious API features.
- Convention-matching: read existing files before writing new ones. Match patterns.
- Verified: check postgres after writes, check playwright after UI changes. Don't claim done without evidence.

## Communication style

Be direct. Skip preamble. State what you're doing, do it, report what happened. If something is risky or ambiguous, flag it and ask. Don't barrel through. If you find a bug while doing other work, surface it.

## Important files

- `docs/PLAYBOOK_ENGINE.md` - architecture spec
- `docs/PLAYBOOK_DESIGN_GUIDE.md` - parser AI instructions (loaded at runtime)
- `docs/TASK_LOG.md` - living progress doc, update after every meaningful change
- `api/services/playbook/executor.ts` - the step dispatch loop
- `api/services/playbook/parser.ts` - loads design guide, calls GPT-4o to generate playbooks
- `api/services/playbook/handlers/` - one file per step type
- `api/services/ai.ts` - OpenAI wrapper
- `api/services/gmail.ts` - Gmail integration + ingest flow
- `api/services/sheets.ts` - Google Sheets integration
