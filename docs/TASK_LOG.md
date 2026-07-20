# Task Log

This is the living record of work on this project. New entries at the top. Used by Copilot to know what's been done and what's next.

## Format

Each entry:
- Date
- Phase + status
- What was done (with file/migration references)

---

## 2026-07-20 - AI layer: thread brief memory and a unified reply composer

**Problem:** `ask_customer` and `send_reply` each built their own prompt context and had quietly
drifted (different transcript windows, different presence checks), and neither `evaluate` nor
`triage` saw any durable memory of a thread, so a second run on the same thread (recategorised,
or the customer returning weeks later) started from an empty context bag. Long threads also sent
their full transcript on every AI call with no cap.

**Changes made:**
- `api/db/migrations/028_thread_brief_and_streaks.sql`: added `threads.brief JSONB` (durable
  per-thread facts plus a lazily regenerated summary) and two playbook trust-ramp columns used by
  a later phase.
- `api/services/playbook/brief.ts`: `getThreadBrief`, `mergeBriefFacts`, `ensureBriefSummary`
  (regenerates the summary only past 8 messages and only when the brief predates the latest
  message) and the pure `shouldRegenerateSummary` decision behind it.
- `api/services/playbook/context-utils.ts`: `isPresent` (one presence check replacing two that
  used to disagree), `formatCappedTranscript` (full transcript at or under 30 messages, summary
  plus the last 10 messages beyond that), and `formatBriefBlock` (renders a thread's facts and
  summary as a THREAD BRIEF prompt section).
- `api/services/playbook/composer.ts`: new `assembleComposerContext`/`buildComposerContext`,
  `composeAskDecision`, `composeReplyBody` - the single place `ask_customer.ts` and
  `send_reply.ts` now build their prompts, replacing their divergent copies.
- `api/services/playbook/handlers/evaluate.ts` and `handlers/triage.ts`: switched from a
  hardcoded last-3-messages window (evaluate) and the uncapped full transcript (triage) to
  `formatCappedTranscript`, and both now prepend `formatBriefBlock`'s THREAD BRIEF section so
  these routing decisions see the same facts/summary the composer sees for customer-facing
  replies. `evaluate.ts`'s REQUIRED VARIABLES prompt line also moved off `?? "(MISSING)"` onto
  `isPresent`, so an empty-string variable is no longer shown as a real value there while also
  being flagged missing elsewhere in the same prompt.
- `api/services/playbook/types.ts` / `executor.ts`: `RunContext.messages` widened to the
  canonical `Message` type (landed slightly earlier than this entry, as part of the thread-brief
  work, since `ensureBriefSummary` needed it).

**Validation:**
- `deno test --allow-net --allow-env --allow-read` in `api/`: `ok | 32 passed | 0 failed`
  (brief_test.ts, context-utils_test.ts, composer_test.ts, plus the pre-existing 29).
- `deno check main.ts` passes.
- `deno lint` shows the same 11 pre-existing problems as before this change, none in the files
  touched here.
- Manual verification: `dry-run.ts` (the playbook sandbox route) turned out to be a fully
  separate hardcoded simulator that never calls `composer.ts`/`brief.ts`/the real handlers, so it
  could not be used to observe the composed prompt as originally planned. Ran
  `assembleComposerContext` directly instead against a synthetic 35-message thread: confirmed the
  output contains a `THREAD BRIEF` block, an `EARLIER CONVERSATION (summary):` line, and only the
  last 10 messages, matching what `ask_customer`/`send_reply` now send. `evaluate`/`triage`'s
  capped-transcript and brief-block behaviour is covered by `context-utils_test.ts` plus code
  review of both handlers, since exercising them live needs Postgres and a real thread brief
  that this repo has no fixture/mocking layer for yet.

---

## 2026-05-24 - Production Google OAuth invalid_grant incident

**Problem:** Production polling for `exclusivemotors12@gmail.com` failed with Google OAuth `invalid_grant` during refresh. Production `/auth/status` showed the stored access token expired at `2026-05-07T01:20:13.475Z`, so the app had been unable to refresh Gmail access for weeks.

**Root cause found so far:**
- Google rejected the stored refresh token. Per Google OAuth docs, refresh tokens can stop working when access is revoked, the account password changes for Gmail-scoped tokens, the OAuth app is in External/Testing mode, time-based access expires, admin/session policies apply, or refresh-token limits are exceeded.
- The app treated the refresh failure as a generic upstream `502` and the Settings page could still show the account as connected because `/auth/status` only checked whether a token row existed.

**Changes made:**
- `api/services/google-auth.ts`: classifies `invalid_grant` by JSON `error` field and throws a reconnect-required `401` instead of a vague refresh `502`.
- `api/routes/auth.ts`: `/auth/status` now attempts a refresh when the token is expired, returns `needs_reauth` when Google rejects it, and returns the updated expiry when refresh succeeds.
- `api/services/watch.ts`: background watch renewal and fallback polling back off reconnect-required accounts for 15 minutes and clear the backoff if the token row is updated by a new OAuth connection.
- `frontend/src/lib/api.ts` and `frontend/src/routes/settings/+page.svelte`: Settings now displays a reconnect-required state instead of showing an expired token as healthy.
- `api/services/google-auth_test.ts`: added tests for `invalid_grant` classification.

**Validation:**
- `deno test --allow-net --allow-env --allow-read` in `api/`: 14 passed.
- `npm run check` in `frontend/`: 0 errors, existing warnings remain.
- `deno lint` still fails on pre-existing unrelated lint issues in `db/queries.ts`, `middleware/*`, playbook handlers, `seed_playbook.ts`, `sheet-rules.ts`, and `routes/playbooks.ts`.

**Production follow-up:**
- User must reconnect Google in production with `exclusivemotors12@gmail.com` via `https://api.exclusivemotorsdashboard.com/auth/google/start`.
- Confirm Google Cloud OAuth consent screen is not External/Testing if this is intended to run longer than 7 days.

## 2026-05-01 - Show triage playbook steps clearly in editor

**Problem:** Newly generated Shopify notification playbooks used the new `triage` step correctly, but the playbook editor did not recognise the type and displayed it as "Unknown" with almost no context.

**Changes made:**
- `frontend/src/routes/playbooks/[id]/+page.svelte`: added `triage` metadata so cards and dry-run traces show "Triage" instead of "Unknown".
- Step cards now summarise triage goal, route labels/gotos, and fallback step, with the full summary available via hover title.
- Step edit modal now supports triage configuration: goal, route definitions, fallback step, and confidence threshold.
- `send_reply` summaries now show when approval is required, since approval can be built into that step without a separate `manual_approval` card.

**Validation:**
- `npm run check` in `frontend/` passes with 0 errors. Existing Svelte warnings remain.

## 2026-05-01 - Triage step for automated Shopify no-action emails

**Problem:** A production Shopify new-order notification was categorised into the Shopify/order category and ran the associated playbook even though it was informational only. The playbook prompt asked the AI to "evaluate whether the email is worth replying to", but the existing `evaluate` step is a variable-presence gate, not an intent/actionability router.

**Changes made:**
- Added a first-class `triage` playbook step for AI route selection on intent/actionability decisions.
- `api/services/playbook/handlers/triage.ts`: reads the full thread context, chooses from configured routes, and falls back to the safe review/action route when the AI is unsure, below threshold, invalid, or unparseable.
- Wired `triage` into playbook types, registry, parser validation, and dry-run traces.
- `docs/PLAYBOOK_DESIGN_GUIDE.md` and packaged `api/docs/PLAYBOOK_DESIGN_GUIDE.md`: instruct the parser to use `triage` for "worth replying to" / automated notification flows, with a Shopify example where informational order notifications route directly to `complete`.
- `api/services/playbook/handlers/triage_test.ts`: added regression coverage for high-confidence no-action routing and safe fallback behavior.

**Validation:**
- `deno fmt` applied to changed backend playbook files.
- `deno check main.ts services/playbook/handlers/triage_test.ts` passes.
- Targeted `deno lint` on changed playbook engine/parser files passes.
- `deno test --allow-env --allow-net --allow-read services/playbook/handlers/triage_test.ts` passes: 3 tests.
- Confirmed `docs/PLAYBOOK_DESIGN_GUIDE.md` and `api/docs/PLAYBOOK_DESIGN_GUIDE.md` are synced.

## 2026-05-01 - Reply to customer email from contact form notifications

**Problem:** Shopify/contact form notifications arrive from an automated store sender, but the real customer email is inside the form body. Approving a draft or sending a manual reply would address the platform sender instead of the customer.

**Changes made:**
- `api/services/reply-address.ts`: added shared reply address resolver. It only overrides the sender when the inbound message looks like a contact/form notification and contains a labelled `Email:` field.
- Wired the resolver into all reply send paths: playbook auto-send, draft-only approval send, ask-customer send, manual replies, and legacy draft approval.
- Pending-send step outputs include `reply_to` and `reply_to_source` for visibility in execution history.
- `api/services/reply-address_test.ts`: added regression coverage for Shopify-style forms, HTML-only forms, and normal customer emails that mention another email address.

**Validation:**
- `deno fmt` applied to changed backend files.
- `deno check main.ts services/reply-address_test.ts` passes.
- Targeted `deno lint` on changed reply-address/send files passes.
- `deno test --allow-env --allow-net services/reply-address_test.ts services/email-text_test.ts` passes: 8 tests.

---

## 2026-05-01 - HTML-only email text for playbook context

**Problem:** Production thread 821 had `body_plain = ''` while `body_html` contained the quoted prior conversation and order `#4593`. Playbook prompts only used `body_plain`, so extraction saw a blank customer message, set `order_number = null`, and drafted a bad request asking for the order number again.

**Changes made:**
- `api/services/email-text.ts`: added shared email text normalisation. It prefers plain text, converts HTML-only bodies with `html-to-text`, removes invisible/preheader noise, and preserves quoted reply content.
- `api/services/gmail.ts`: stores HTML-derived readable text into `messages.body_plain` during ingestion when Gmail provides no plain body.
- Playbook and categorisation prompts now use the shared transcript formatter and include message timestamp, speaker, sender, and HTML-derived body text.
- `api/scripts/backfill_html_email_text.ts`: dry-run/apply script to backfill existing HTML-only messages.
- `api/scripts/rerun_draft_only_playbook_run.ts`: safe draft-only rerun script for replacing bad pending drafts after backfill.
- `api/services/email-text_test.ts`: regression tests for HTML-only quoted replies containing `Order number #4593`.

**Validation:**
- `deno fmt` applied to changed backend files.
- `deno check main.ts` passes.
- Targeted `deno check` on changed services/scripts passes.
- Targeted `deno lint` on changed services/scripts passes.
- `deno test --allow-env --allow-net services/email-text_test.ts` passes: 4 tests.
- Local dry-run of Tracking playbook with the Kadin email routes `extract_1 -> evaluate_1 -> send_1 -> complete` and extracts `order_number: "#4593"`.
- Backfill script dry-run against local Postgres found 4 HTML-only rows and made no changes without `--apply`.

**Production action after deploy:**
- Run `cd api && DATABASE_URL=... deno run --allow-net --allow-env scripts/backfill_html_email_text.ts --apply`.
- Then run `cd api && DATABASE_URL=... deno run --allow-net --allow-env --allow-read scripts/rerun_draft_only_playbook_run.ts --run-id=302 --apply` to replace the known bad pending draft.

---

## 2026-04-30 - Backfill Gmail thread context during ingestion

**Problem:** When a customer replied to a Gmail conversation that existed before the dashboard saw it, the webhook only stored the newest Gmail message. Categorisation and playbooks then saw that reply as a contextless new thread.

**Changes made:**
- `api/services/gmail.ts`: when ingesting a webhook message, `threads.get?format=full` is still used, but ingestion now inserts every missing message from the returned Gmail conversation before categorisation/resume logic runs.
- Added a shared parser for Gmail message fields so historical and current messages store the same body, direction, received time, labels, and RFC 2822 `Message-ID` data.

**Validation:**
- `deno fmt api/services/gmail.ts` applied.
- `deno lint api/services/gmail.ts` passes.
- `deno check api/services/gmail.ts` passes.

---

## 2026-04-30 - Gmail labels authoritative routing toggle

**Problem:** Some stores use reliable Gmail filters/labels and do not want the AI to re-categorise those inbound emails or write category labels back to Gmail.

**Changes made:**
- `frontend/src/routes/settings/+page.svelte`: added a global boolean setting, `gmail_labels_authoritative`, labelled "Use Gmail labels for categories".
- `api/services/gmail.ts`: when the setting is enabled, inbound ingestion routes from Gmail label IDs instead of calling AI categorisation.
- `api/services/categorisation.ts`: added `categoriseFromGmailLabels()` and shared category/playbook routing so AI and Gmail-label paths behave consistently after category selection.
- `api/services/gmail.ts`: label sync now skips dashboard-to-Gmail creation/renames while Gmail-authoritative mode is enabled, and only links/imports Gmail labels into categories.
- `docs/PLAYBOOK_ENGINE.md`: documented the Gmail-authoritative mode.

**Validation:**
- `deno fmt services/gmail.ts services/categorisation.ts` applied.
- `deno check main.ts` passes.
- `deno lint services/gmail.ts services/categorisation.ts` passes.
- `npm run check` in `frontend/` passes with 0 errors; existing unrelated warnings remain.
- Playwright smoke test on local Vite `http://127.0.0.1:3001/settings` verified the new toggle renders and saves on/off through the SvelteKit API proxy when `API_SECRET` is loaded.
- Postgres verified `settings.gmail_labels_authoritative` ended as `false` after the smoke test reset.

---

## 2026-04-30 - Inbox thread email rendering

**Problem:** Thread detail pages displayed `body_plain` directly, so HTML emails and plain-text email link patterns such as `View your order<https://...>` looked broken and noisy.

**Changes made:**
- `frontend/src/routes/threads/[id]/+page.svelte`: renders each message in a sandboxed `srcdoc` email frame using stored `body_html` when available.
- Added a plain-text fallback that escapes text, preserves line breaks, and turns common `Label<https://...>` email links into readable anchors.
- Email frames auto-size to their content and use a light email document surface so real email markup is isolated from dashboard styling.

**Validation:**
- `npm run check` in `frontend/` passes with 0 errors; existing unrelated warnings remain.
- Docker stack started with `docker compose up -d postgres api frontend`.
- Verified via Postgres that stored messages contain both HTML and plain-only cases.
- Verified in Playwright on `http://localhost:3000/threads/115` that stored HTML messages render in email frames with no raw angle-bracket URL artifacts.
- Inserted and removed a temporary plain-only test thread; Playwright confirmed `View your order<https://...>` renders as link text with the correct URL and no visible raw `<https://...>`.
- Verified mobile viewport width `390px` has no message bubble overflow.

## 2026-04-30 - Production playbook parser guide packaging fix

**Problem:** Production `POST /playbooks/parse` returned 500 because the API container could not read `/app/docs/PLAYBOOK_DESIGN_GUIDE.md`.

**Root cause:** Local Compose mounted `./docs:/docs`, but production API images were built from the `api/` context, so the repo-root design guide was not packaged into the runtime filesystem.

**Changes made:**
- `api/Dockerfile`: supports repo-root and `api/` build contexts, copying the API files plus `docs/PLAYBOOK_DESIGN_GUIDE.md` into `/app/docs` when built from the repo root.
- `docker-compose.yml`: API build context changed to the repo root with `api/Dockerfile`, so Dokploy Compose builds include the guide.
- `api/docs/PLAYBOOK_DESIGN_GUIDE.md`: packaged copy for standalone API Dockerfile deployments that still build from `api/`.
- `.dockerignore`: keeps repo-root API builds from sending frontend assets, screenshots, local env files, and git metadata.

**Validation:**
- `docker compose config --quiet` passes.
- `deno fmt services/playbook/parser.ts` applied; `deno fmt --check services/playbook/parser.ts` passes.
- `docs/PLAYBOOK_DESIGN_GUIDE.md` and `api/docs/PLAYBOOK_DESIGN_GUIDE.md` are byte-for-byte synced.
- Local `docker build -f api/Dockerfile --target production -t ecom-autopilot-api:test .` was attempted but Docker Desktop hung on credential/metadata lookup before evaluating the Dockerfile, then was cancelled.

## 2026-04-30 - Gmail label sync imports categories

**Problem:** Production Settings -> Sync Labels reported `0` even when Gmail had existing user labels. The sync path only logged unknown Gmail labels instead of importing them.

**Changes made:**
- `api/services/gmail.ts`: keeps the existing categories -> Gmail pass, then imports untracked user-created Gmail labels as blank categories linked by `gmail_label_id`.
- `api/services/gmail.ts`: creates the same blank inactive playbook for imported labels that normal dashboard category creation creates.
- `docs/PLAYBOOK_ENGINE.md`: updated the label sync spec from dashboard-only source of truth to two-way category/label convergence.

**Validation:**
- `deno fmt services/gmail.ts` applied.
- `deno fmt --check services/gmail.ts` passes.
- `deno check main.ts` passes.
- `deno lint services/gmail.ts` passes.
- Full `deno lint` still fails on existing repo-wide lint issues unrelated to this change, including unversioned `npm:hono` imports and unused variables in older files.

---

## 2026-04-29 - Sync Columns range parsing fix

**Problem:** Production Sync Columns returned Google Sheets `400 INVALID_ARGUMENT`: `Unable to parse range: 1WvR96hg85cSudlWtfJrjhitzntkGDXvu0TldNA20hEo!1:1`.

**Root cause:** The app builds the header range as `{workspace.sheet_name}!1:1`. That error proves production has `workspace.sheet_name` set to the spreadsheet ID, not the tab name. The spreadsheet ID belongs only in `workspace.sheet_id`; `workspace.sheet_name` must be the tab label at the bottom of the spreadsheet, e.g. `Sheet1`.

**Changes made:**
- `api/services/sheets.ts`: quotes sheet names in A1 notation (`'Sheet1'!1:1`) so names with spaces, punctuation, or names that look like cell/range tokens parse correctly.
- `api/routes/workspaces.ts`: normalises pasted Google Sheets URLs into raw spreadsheet IDs and rejects sheet names that are equal to, or look like, spreadsheet IDs.
- `api/routes/sheets.ts`: returns a clear `422` if an existing workspace has `sheet_name` set to a spreadsheet ID before calling Google.

**Validation:**
- `deno check main.ts` passes.
- `deno fmt` applied to changed backend files.
- API rejects `PATCH /workspaces/1` when `sheet_name` is a spreadsheet ID.
- API accepts a pasted Google Sheets URL in `sheet_id` and normalises it to the raw ID when `sheet_name` is `Sheet1`.

**Production action:** After deploy, edit the workspace and set **Sheet name** to the actual tab name (for example `Sheet1`), then run Sync Columns again.

---

## 2026-04-29 - Dashboard auth persistence and OAuth status fix

**Problem:** Live dashboard repeatedly showed the password gate and Google OAuth appeared to complete, but Settings still showed the account as not connected.

**Root causes found:**
- `frontend/src/routes/login/+page.svelte` posted to `?/default`, which SvelteKit rejects for unnamed/default actions during enhanced form submissions (`Cannot use reserved action name "default"`). Browser logins could 500 instead of reliably setting the `dashboard_session` cookie.
- Frontend API calls depended on a browser-side bearer token in `localStorage.api_token`; the password login flow did not reliably establish that token, and storing the API secret in browser storage is not appropriate for production.
- `frontend/vite.config.ts` had a stale `/api` dev proxy to `localhost:8000`, which bypassed SvelteKit and fails inside the Docker frontend container.
- The new SvelteKit proxy initially forwarded `content-encoding: gzip` after Node fetch had decoded the body, causing Chrome `ERR_CONTENT_DECODING_FAILED`.

**Changes made:**
- Added `frontend/src/routes/api/[...path]/+server.ts`: same-origin API proxy that injects `Authorization: Bearer <API_SECRET>` server-side only.
- Changed `frontend/src/lib/api.ts` to call same-origin `/api` and removed all browser bearer-token reads.
- Changed `frontend/src/lib/sse.ts` to connect through `/api/events/...` without token query params.
- Fixed login form action to post to the unnamed action correctly while preserving `returnTo`.
- Added legacy cleanup in `frontend/src/routes/+layout.svelte` to remove old `localStorage.api_token` from existing browsers.
- Removed the stale Vite `/api` proxy and added `SERVER_API_BASE_URL=http://api:8000` for Docker frontend-to-api traffic.

**Validation:**
- `npm run check` in `frontend/`: 0 errors, existing unrelated warnings remain.
- Docker stack recreated/restarted.
- `curl` login sets `dashboard_session` with `Max-Age=2592000`, `HttpOnly`, `SameSite=Lax`.
- `curl` with only dashboard cookie to `http://localhost:3000/api/auth/status` returns connected Google account JSON.
- `curl` to `http://localhost:3000/api/auth/google/start` via frontend proxy returns Google OAuth 302.
- Playwright: logged in from `/login?returnTo=/settings`, landed on `/settings`, refresh stayed on dashboard, Settings showed connected Google account, and `localStorage.getItem("api_token") === null`.

**Deployment note:**
- Production frontend needs `API_SECRET` available server-side and `SERVER_API_BASE_URL=https://api.exclusivemotorsdashboard.com` (or the internal API URL if Dokploy provides one). No API secret should be exposed as `PUBLIC_*` or stored in browser storage.

---

### Follow-up: production `/api/auth/google/start` returned 500

**Observed:** Direct API endpoint `https://api.exclusivemotorsdashboard.com/auth/google/start` returns a valid 302 to Google, so the API OAuth route itself is healthy.

**Likely cause:** The frontend proxy was deployed without `SERVER_API_BASE_URL`, causing the proxy fallback to target `http://localhost:8000` from inside the frontend runtime.

**Fix:** Updated `frontend/src/routes/api/[...path]/+server.ts` so, when explicit server env is missing, it infers the API origin from the dashboard host:
- `https://exclusivemotorsdashboard.com` → `https://api.exclusivemotorsdashboard.com`
- localhost → `http://localhost:8000`

Also added a caught upstream error response (`502` JSON with the attempted target URL) instead of an opaque SvelteKit 500.

**Validation:** `npm run check` still reports 0 errors. Local `/api/auth/google/start` still returns a Google OAuth 302 through Docker.

---

## 2026-04-19 - Fix manual_approval input field not shown on second waiting_for_human pause

**Phase**: bugfix
**Status**: complete

### Root cause

Two bugs, same flow: refund playbook had `ask_2` (ask_customer with `require_approval`) followed later by `approval_1` (manual_approval with `capture_input: true`).

**Bug 1 (primary - reported)**: On `+page.svelte`, the SSE `run_updated` handler merged raw DB run data with the old run via `{ ...oldRun, ...sseRun }`. The SSE payload has only real DB columns — the SQL-computed `step_capture_input`, `step_input_prompt`, `step_pending_send`, `step_reference_context` fields are absent. When the run transitioned from `ask_2` pause (step_capture_input=false) to `approval_1` pause (step_capture_input=true), the merge preserved the stale `false` value from the previous pause. `ManualActionBanner.captureInput` stayed false, the input textarea never rendered, and clicking approve sent no input — so `approved_amount` was never captured and `send_1` re-generated the same message.

**Bug 2 (secondary - silent)**: `resumeRun` in `executor.ts` had a fallback for `waiting_for_customer` runs where `current_step_id` is not an `ask_customer` step. The approve endpoint already advances `current_step_id` to `on_reply_goto` (`extract_2` in this case). The fallback then incorrectly advanced one step further, skipping `extract_2` entirely. `refund_reason` was never extracted.

### Fix

- **`frontend/src/routes/threads/[id]/+page.svelte`**: In the `run_updated` SSE handler, after the standard merge, when `run.status === 'waiting_for_human'`, re-fetch the full runs list via `playbooksApi.listRuns({ thread_id })`. This hydrates the SQL-computed `step_*` fields so `ManualActionBanner` receives correct data.

- **`api/services/playbook/executor.ts`** `resumeRun` fallback: Instead of advancing to `steps[currentIndex + 1]`, keep `current_step_id` as-is and set status to `running`. Since the approve endpoint already positioned `current_step_id` at the target step, `advanceRun` will start there correctly.

### Docs consulted

- Svelte 5 runes: `/sveltejs/svelte` via context7 — confirmed `$derived` / `$state` patterns for the SSE handler



---

## 2026-04-19 - Store profile feature

**Phase**: features
**Status**: complete

### What was done

Added a store profile (store name, description, URL) to each workspace so the AI has business context when generating replies and categorising emails.

- **Migration**: `api/db/migrations/025_workspace_store_profile.sql` - adds `store_name`, `store_description`, `store_url` nullable TEXT columns to `workspaces`
- **Backend types**: `api/types/index.ts` - added three fields to `Workspace` and `CreateWorkspacePayload`
- **Workspace route**: `api/routes/workspaces.ts` - added fields to PATCH allowed list and POST INSERT
- **Store profile helper**: `api/services/store-profile.ts` - formats workspace profile into an AI-ready string
- **AI injection**: `api/services/ai.ts` `categoriseEmail()` - loads and injects store profile into system prompt
- **RunContext**: `api/services/playbook/types.ts` - added `storeProfile: string | null`
- **Executor**: `api/services/playbook/executor.ts` - loads store profile once per run, passes to all handlers
- **Handlers updated**: `send_reply.ts`, `ask_customer.ts`, `extract.ts`, `evaluate.ts` - conditional injection into system prompts
- **Frontend types**: `frontend/src/lib/api.ts` - `Workspace` and `WorkspacePayload` updated
- **Settings page**: `frontend/src/routes/settings/+page.svelte` - three new fields in the workspace edit form

### Design decisions

- Workspace columns over settings key-value: store profile is core identity metadata with structure, already loaded in all AI paths
- Injection is conditional (only when non-null) so existing behavior is unchanged when no profile is set
- Store context phrasing tells AI to use it naturally, not robotically

---

## 2026-04-19 - Fix SSE live update gaps (new threads not appearing)

**Phase**: live-updates
**Status**: complete

### Root cause

Two code paths never published `thread_updated`, so new threads would land in the collapsed "Other / Noise" bucket and never move to "Needs Attention":

1. **`advanceRun` pause case** (`api/services/playbook/executor.ts`): returned early before the thread status update (`UPDATE threads SET status = 'in_review'`) and the `thread_updated` publish at the bottom of the function. Playbooks that paused (waiting_for_human / waiting_for_customer) left the thread at its old status and the frontend was never notified.

2. **`categoriseAndDraft`** (`api/services/categorisation.ts`): set `category_id` and optionally `status = 'in_review'` but never published `thread_updated`, so the frontend never saw the category change.

### Fix

- `executor.ts` `pause` case: added `UPDATE threads SET status = 'in_review'` + `fetchThreadListItem` + `publish("thread_updated")` before the early return
- `categorisation.ts`: added `publish` and `fetchThreadListItem` imports, added `thread_updated` publish after every code path that updates the thread (both playbook and no-playbook paths)
- `frontend/src/routes/+page.svelte` `thread_updated` handler: changed from `map` (update-only) to upsert — if thread isn't in the list yet (e.g. `thread_created` was missed during reconnection), it's prepended

### Verified (playwright)

SSE delivers `thread_updated` to browser within ~1s. Thread appears in "NEEDS YOUR ATTENTION" group without page refresh.

---

## 2026-04-18 - Live updates via SSE

**Phase**: live-updates
**Status**: complete

### What was done

Real-time push from backend to frontend for all meaningful state changes — new threads, status updates, playbook step progress — using Server-Sent Events.

**New files:**
- `api/db/queries.ts` — `fetchThreadListItem(threadId, workspaceId)` shared denormalized thread fetch used by all publishers
- `api/services/event-bus.ts` — in-memory pub/sub singleton (`publish`, `subscribe`). 6 event types: `thread_created`, `thread_updated`, `message_created`, `run_updated`, `step_execution_created`, `step_execution_updated`
- `api/routes/events.ts` — `GET /events/workspace` and `GET /events/thread/:threadId` SSE endpoints with auth via `?token=` query param (Bearer header fallback). 30s ping heartbeat to keep proxies alive
- `frontend/src/lib/sse.ts` — `openSSE(path, params)` factory that builds the URL with token from localStorage

**Modified files:**
- `api/deno.json` — added `hono/streaming` to import map
- `api/main.ts` — registered `eventsRouter` at `/events`
- `api/services/gmail.ts` — publishes `thread_created`/`thread_updated` on ingest, `message_created` on inbound and outbound messages
- `api/services/playbook/executor.ts` — publishes `step_execution_created` on step start, `step_execution_updated` on step completion, `run_updated` on every state change (paused, retrying, failed, per-step), `thread_updated` at run completion. Also fixed hardcoded `sendAlert(1, ...)` → `sendAlert(workspaceId, ...)`
- `api/routes/threads.ts` — publishes `thread_updated` after `PATCH /:id/status` and `PATCH /:id/drafts/:draftId`
- `frontend/src/routes/+page.svelte` — `$effect` opens workspace SSE, handles `thread_created`/`thread_updated` live, reconnect triggers full reload
- `frontend/src/routes/threads/[id]/+page.svelte` — `$effect` opens thread SSE, handles all 5 event types for live playbook step visualization

**Verified:** API logs show `GET /events/workspace 200`, browser confirms SSE request fires to `http://localhost:8000/events/workspace?token=...&workspace_id=1`

---

## 2026-04-18 - Simplify playbooks: one per category, no versioned UX

**Phase**: simplification
**Status**: complete

### Problem

Playbooks looked versioned (`v2`, `v5`) and the system still allowed flows that implied multiple playbooks per category or orphan playbooks. This created confusion versus the intended product model: one playbook per category, with the current editable definition as the source of truth.

### What was done

**Migration** (`api/db/migrations/024_playbook_unique_per_category.sql`):
- Added a partial unique index on `playbooks(category_id)` where `category_id IS NOT NULL`.
- Enforces max one playbook per category at the database layer.

**Backend categories route** (`api/routes/categories.ts`):
- Updated `POST /categories` to create category + blank inactive playbook in one `transaction()`.
- New category now always starts with an associated playbook (`steps=[]`, `is_active=false`).

**Backend playbooks route** (`api/routes/playbooks.ts`):
- `POST /playbooks` now requires `category_id`, validates category belongs to workspace, and returns `409` if category already has a playbook.
- `PUT /playbooks/:id` no longer bumps `version` when steps change.
- `PUT /playbooks/:id` now prevents category collisions (same `409`) and validates target category belongs to workspace.

**Frontend list page** (`frontend/src/routes/playbooks/+page.svelte`):
- Removed version display from playbook rows.
- Removed global `+ New Playbook` action and unlinked-playbooks section.
- Category row now resolves directly to its single associated playbook.

**Frontend editor page** (`frontend/src/routes/playbooks/[id]/+page.svelte`):
- Removed version badge from the header.

**Frontend API + new page**:
- `frontend/src/lib/api.ts`: `playbooksApi.create` now requires `category_id`.
- `frontend/src/routes/playbooks/new/+page.svelte`: now errors when `category_id` is missing, preventing orphan playbook creation.

### Verification

- API test: creating a category auto-created a blank inactive playbook in the same workspace.
- API test: creating a second playbook for the same category returns `409 Category already has a playbook`.
- API test: creating playbook without `category_id` returns `422 category_id is required`.
- API test: updating a playbook no longer increments `version`.
- UI check: `/playbooks` no longer shows `vN`; `/playbooks/:id` no longer shows version badge.


## 2026-04-18 - Thread status sync with playbook completion + cancel on manual close

**Phase**: bugfix
**Status**: complete

### Problem

When a playbook run completed, the thread status was set to `replied` in the executor. On the main threads page, those threads appeared in the "Other / Noise" group (which the user called "the completed bit"). On the individual thread page, the status pill showed `replied` — creating an inconsistency. The user expected `closed` to represent "fully done", and wanted manual status changes to cancel active playbook runs with a confirmation step.

### Root causes

1. `executor.ts` mapped `run.status = 'complete'` → `thread.status = 'replied'`. Should be `closed`.
2. The approve route in `playbooks.ts` had one code path that set `playbook_runs.status = 'complete'` directly without also updating `threads.status`.
3. No cancel endpoint existed for playbook runs.
4. The thread detail page had no guard against changing status while a run was active.

### What was done

**Migration** (`api/db/migrations/023_run_cancelled_status.sql`): drops and re-adds the `playbook_runs` status CHECK constraint to include `'cancelled'` alongside the existing values.

**Backend executor** (`api/services/playbook/executor.ts`): changed `'replied'` to `'closed'` in the thread status update when run status is `complete`.

**Backend playbooks route** (`api/routes/playbooks.ts`):
- In the approve handler's `else` branch (no next step after a pending_send approval), added `UPDATE threads SET status = 'closed'` after marking the run complete.
- Added `POST /playbooks/runs/:runId/cancel` endpoint. Accepts runs in `running`, `waiting_for_customer`, `waiting_for_human`, or `retrying` status; sets them to `cancelled`. Returns 409 for non-cancellable statuses.

**Frontend API client** (`frontend/src/lib/api.ts`):
- Added `'retrying' | 'cancelled'` to the `PlaybookRun.status` union type.
- Added `cancelRun(runId)` method to `playbooksApi`.

**Frontend thread detail page** (`frontend/src/routes/threads/[id]/+page.svelte`):
- Added `ACTIVE_RUN_STATUSES` constant and `activeRuns` `$derived` that filters runs to only those in an active state.
- Added `pendingStatus` `$state` to track a status change awaiting confirmation.
- Replaced `handleStatusUpdate` with three functions: `requestStatusUpdate` (checks for active runs and either proceeds directly or sets `pendingStatus`), `applyStatusUpdate` (performs the API call), and `confirmStatusUpdate` (cancels active runs then applies the status update).
- Added a confirmation banner (`confirm-banner`) that appears when `pendingStatus` is set, showing the run count and offering "Cancel run(s) and continue" or "Keep running".
- Added CSS for `.confirm-banner`, `.confirm-text`, `.confirm-actions`, `.btn-danger`, `.btn-sm`.



---

## 2026-04-18 - Remove template library

**Phase**: cleanup
**Status**: complete

Removed the template library feature entirely — it was never wired into real user flows and added dead surface area.

**Migration** (`api/db/migrations/022_drop_playbook_templates.sql`): drops the `playbook_templates` table and its indexes.

**Backend removed**:
- `api/routes/playbook-templates.ts` — deleted
- `api/main.ts` — removed import and `app.route("/playbook-templates", ...)` registration
- `api/db/seeds/playbook_templates.sql` — deleted

**Frontend removed**:
- `frontend/src/lib/api.ts` — removed `PlaybookTemplate` interface and `playbookTemplatesApi` export
- `frontend/src/routes/playbooks/+page.svelte` — removed the "Template Library" card HTML and its associated CSS rules (`.template-library`, `.template-header`, `.template-desc`, `.template-btn`)



---

## 2026-04-18 - Bug fix: require_approval on ask_customer steps

**Phase**: bugfix
**Status**: complete

### What was done

**Root causes identified:**
1. The legacy path in `ask_customer` (steps with a literal `message` but no `goal`) was sending the message directly without checking `require_approval`. The AI-driven path (steps with `goal`) already checked `require_approval` correctly.
2. The `ManualActionBanner` component did not differentiate between `manual_approval` pauses and `require_approval` message-draft pauses. It showed generic "Action required" UI with no message preview, so users had no way to see or edit the draft before approving. When they clicked "Done, continue" the AI draft was sent silently via the backend fallback.

**Backend fix** (`api/services/playbook/handlers/ask_customer.ts`):
- Legacy path (no `goal`) now checks `requireApprovalLegacy = askStep.require_approval === true || ctx.playbook.reply_mode === "draft_only"` before sending.
- When `requireApprovalLegacy` is true, returns `{ action: "pause", status: "waiting_for_human" }` with `output.action = "pending_approval"` — the same format the approve route already handles for AI-driven steps.

**Frontend fix** (`frontend/src/lib/components/ManualActionBanner.svelte`):
- Added `isPendingSend` derived state: true when `run.step_pending_send` is a non-empty string.
- When `isPendingSend` is true: shows "Review draft reply" heading (Mail icon), displays the AI-drafted message in an editable textarea, and the approve button reads "Send reply" — passing the (possibly edited) body to `approveRun(run.id, undefined, draftBody)`.
- When `isPendingSend` is false: existing `manual_approval` UI is unchanged (reason, reference context, optional input field, "Done, continue" button).
- Added `banner-draft` CSS modifier for visual distinction.
- Used `untrack()` from svelte to safely initialize `draftBody` from `run.step_pending_send` at mount time without triggering reactive warnings.

**No migrations needed** — all changes are logic/UI only.

---

## 2026-04-17 - Playbooks as source of truth (Phase 1 follow-up)

**Phase**: 1 follow-up (pending-send approval UX + cleanup)
**Status**: complete

### What was done

Completed the remaining items after Phase 1:

**Dead code removal**:
- `api/services/ai.ts` — removed `draftReply()` function and `DraftReplyResult` import
- `api/types/index.ts` — removed `DraftReplyResult` interface

**Backend: pending-send approval API** (`api/routes/playbooks.ts`):
- `GET /playbooks/runs` — added `step_type` and `step_pending_send` columns to the query response. `step_type` returns the step's type from the playbook steps array; `step_pending_send` fetches `output->>'pending_send'` from the most recent `playbook_step_executions` row with `action = 'pending_approval'` for `waiting_for_human` runs.
- `POST /playbooks/runs/:runId/approve` — now accepts optional `{ body: string }` in request body. When a pending_send step is being approved and `body` is provided (and non-empty), that body is used instead of the AI-drafted `pending_send` from the step execution.
- `POST /playbooks/runs/:runId/reject` — now handles `ask_customer` and `send_reply` step types: rejects by escalating the run (instead of erroring with "not a manual_approval step").

**Docs**: `docs/PLAYBOOK_DESIGN_GUIDE.md`:
- Updated `ask_customer` step fields: `voice_hint` description updated to "step-level tone override", added `require_approval` field documentation
- Added Principle 7: voice/tone lives at the playbook level, steps only use `voice_hint` when deviating
- Added Principle 8: `require_approval` is explicit, not assumed — parser should only add it when description explicitly says so

**Frontend**:
- `frontend/src/lib/api.ts` — added `step_type` and `step_pending_send` to `PlaybookRun` interface; updated `approveRun()` to accept optional `body` parameter and send it in the request
- `frontend/src/routes/review/+page.svelte`:
  - Added `runBodies` state (`Record<number, string>`) for per-run editable reply bodies
  - `load()` initialises `runBodies` from `step_pending_send` on each run
  - `approveRun()` now passes `runBodies[runId]` as the body override
  - Approval card: when `run.step_pending_send` is set, shows `<textarea>` with the AI draft (editable), "edited" badge when changed, "Reset to AI draft" button
  - Label distinguishes `ask_customer` ("Message to customer (held for approval)") vs `send_reply` ("Reply to send (held for approval)")

**Verified**:
- `deno check main.ts` → 0 errors
- `pnpm check` → 0 errors
- API: `GET /playbooks/runs?status=waiting_for_human` returns correct `step_type` + `step_pending_send`
- Browser: approval card shows editable draft, "edited" badge appears on change, "Reset to AI draft" restores original, Approve sends edited body to API, Reject escalates the run, queue clears after action

---

## 2026-04-17 - Playbooks as source of truth (Phase 1)

**Phase**: 1 (playbooks own reply behaviour)
**Status**: complete

### What was done

Migrated all reply configuration from categories to playbooks. Categories are now pure classification labels. Per-step approval and voice hints added.

**Migration**: `api/db/migrations/021_playbook_source_of_truth.sql`
- Added `writing_style TEXT NOT NULL DEFAULT ''`, `reply_mode TEXT NOT NULL DEFAULT 'draft_only' CHECK (...)`, `confidence_threshold NUMERIC(4,3) NOT NULL DEFAULT 0.800` to `playbooks`
- Dropped `allow_auto_reply`, `confidence_threshold`, `writing_style`, `migrated_to_flows` from `categories`

**Backend**:
- `api/types/index.ts` - `Category` / `CreateCategoryPayload` stripped to name, description, instructions, gmail_label_id only
- `api/services/playbook/types.ts` - `Playbook` gets `writing_style`, `reply_mode`, `confidence_threshold`; `AskCustomerStep` and `SendReplyStep` get optional `require_approval`, `voice_hint`
- `api/services/categorisation.ts` - removed legacy auto-draft path; confidence checked against `playbook.confidence_threshold`; voice inherited from playbook
- `api/services/playbook/handlers/ask_customer.ts` - voice from `step.voice_hint ?? playbook.writing_style`; pause if `require_approval` or `reply_mode === 'draft_only'`
- `api/services/playbook/handlers/send_reply.ts` - same treatment
- `api/services/playbook/approval-sender.ts` - new service: `sendApprovedReply(run, body)` for approved pending-send steps
- `api/services/playbook/parser.ts` - added `parsePlaybookStep()` for inline step generation
- `api/routes/playbooks.ts` - POST/PUT accept new fields; added `POST /playbooks/parse-step`; `approve` endpoint handles `pending_send` steps via `sendApprovedReply()`
- `api/routes/categories.ts` - CREATE/UPDATE/PATCH restricted to name, description, instructions only

**Frontend**:
- `frontend/src/lib/api.ts` - updated Category/Playbook interfaces, added `parseStep()` method
- `frontend/src/routes/categories/+page.svelte` - removed all reply config fields; added info note redirecting to playbook
- `frontend/src/routes/playbooks/+page.svelte` - playbook cards now show reply_mode and confidence from playbook
- `frontend/src/routes/playbooks/[id]/+page.svelte` - top bar has Writing style, Reply mode, Min confidence; step editors show Voice hint and Require approval toggle; inline `+ insert step` rows and `+ Add step` flow using `parsePlaybookStep`

**Verified**:
- `deno check main.ts` → 0 errors
- `pnpm check` → 0 errors (52 pre-existing warnings)
- API smoke: categories return no reply fields, playbooks return all three new fields
- Browser: categories modal shows only name/desc/instructions; playbook cards show reply_mode+confidence; editor shows writing_style, reply_mode, confidence, per-step voice_hint and require_approval toggles; Add step form renders; writing_style persists to DB ✓

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
- Phase 7 Task 3-5: Learning loop, richer step types, playbook routing (per client demand).

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

- DB was already ahead of codebase: plaintext token columns were already dropped, and migrations 006-010 (match_strategy_confidence, sheet_rule_feedback, flows, flow_links, unified_pipeline) already applied. Removed all transition/fallback code entirely rather than adding compatibility shims.
- Migration numbering collision: our new 006-009 files coexist with pre-existing 006_match_strategy_confidence through 010_unified_pipeline. No conflict because `schema_migrations` tracks by full filename, not number prefix.
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
## 2026-05-01 - Make recategorised playbook runs resilient to stale approval steps

**Problem:** A thread could be recategorised and completed by a newer playbook run while an older `waiting_for_human` run still existed. The stale run kept the thread in the "Action required" UI. If the live playbook had since been edited, the stale run's `current_step_id` could no longer be found, so Done/Skip returned "Current step not found in playbook".

**Changes:**
- Added migration `027_playbook_run_steps_snapshot.sql`.
  - Adds `playbook_runs.steps_snapshot`.
  - Backfills existing runs from their current playbook.
  - Cancels active runs whose `current_step_id` is missing from the snapshot.
- New playbook runs now store an immutable copy of their starting steps.
- `advanceRun`, `resumeRun`, approval actions, and delayed-send worker now read from the run snapshot instead of the mutable live playbook.
- Recategorisation now cancels any active runs for that thread before routing to the newly selected category/playbook.
- Thread list `has_pending_action` now only counts `waiting_for_human` runs whose current step exists in the run snapshot.
- Thread detail banner ignores stale waiting runs with missing steps.
- Approve/reject on an already-stale waiting run now cancels the run and returns a normal response instead of a 409.

**Validation:**
- `deno check main.ts` passed.
- `deno test --allow-net --allow-env --allow-read` passed: 11 tests.
- `npm run check` passed with 0 errors and existing Svelte warnings.
- Local Postgres has migration `027_playbook_run_steps_snapshot.sql` applied; existing runs have snapshots populated.
- API smoke check showed recent closed/completed threads have `has_pending_action: false`.
- Playwright smoke on host dev server `127.0.0.1:5174` for thread `116`: closed thread rendered with 0 "Action required" banners and 0 "Current step not found in playbook" messages.

---
