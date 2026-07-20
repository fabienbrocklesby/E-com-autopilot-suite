# E-com Autopilot Rethink: Design

Date: 2026-07-20
Status: Approved by Fabien (section-by-section), pending spec review
Client context: Kieran (Exclusive Motors, exclusivemotorsdashboard.co.nz) reports the app as incomplete: AI replies are poor quality and playbook runs fail. Goal: AI handles most inbound store email end to end with real thread context; the remainder is easy to reply to manually from the dashboard.

## 1. Investigation verdict

Four parallel code audits (playbook engine, email pipeline, frontend, docs/schema/history) converge: the core engine design (step cursor, JSONB context bag, steps_snapshot, per-step audit log, pause/resume state machine) is sound and stays. The failures trace to four specific defect clusters:

1. **Reply-time context starvation.** Reply-writing prompts see only the last 3-5 messages even though the full thread is loaded in `ctx.messages`:
   - `api/services/playbook/handlers/send_reply.ts` (`ctx.messages.slice(-3)`)
   - `api/services/playbook/handlers/ask_customer.ts` (`slice(-5)`)
   - `api/services/playbook/handlers/evaluate.ts` (`slice(-3)`)
   Anything said earlier is invisible unless an extract step stored it as a variable. The context bag is flat and unschema'd.
2. **Run cancellation on mid-run inbound.** In `api/services/gmail.ts` ingest, only `waiting_for_customer` runs resume. A customer reply during `waiting_for_human`, `waiting_to_send`, or `retrying` falls through to full recategorisation, which cancels the active run (`cancelActiveRunsForRecategorisation` in `api/services/categorisation.ts`) and starts a new run with `context = '{}'`. Extracted variables, sheet lookups, and pending approvals silently vanish.
3. **Escalate/failed status conflation.** `escalate` steps and AI escalate decisions return `{action: "fail"}`, so runs land in `status='failed'`, not `'escalated'` (executor fail branch, `api/services/playbook/executor.ts`). Alerting never fires for deliberate escalations; the ops dashboard undercounts; the two human-reject flows produce different terminal statuses. Separately, structural errors (missing OAuth token, missing thread) propagate uncaught out of `advanceRun` and wedge runs in `running` forever; `startRun` failures in `categorisation.ts` are swallowed by a bare `console.error`.
4. **Orphaned review UI.** `/review` (the purpose-built approval and manual-reply queue), `/sheet-rules`, and `/sheet-updates` have no navigation links anywhere. The owner cannot discover the exact workflow the product goal describes.

Also verified: `CLAUDE.md`'s known-issues list is partially stale (the evaluate full-context issue was fixed 2026-04-15; escalation reasons are partially fixed on the rejection path; the design-guide complexity principle already exists). Docs need truing up as part of this work.

## 2. Scoping decisions (made 2026-07-20)

- **Trust model**: draft-first ramp. Every category starts draft-only; per-category graduation to auto-send on an approval streak.
- **AI provider**: stay on OpenAI GPT-4o via the existing `chatCompletion` wrapper. No provider migration this round.
- **Order data**: stay Google-Sheets-based. Direct Shopify Admin API lookups are a later phase.
- **Grounding**: Fabien wires up read access to the production database. Before implementation of the AI layer is declared done, pull ~20 real threads to verify defect attribution and build a before/after reply-quality benchmark.

## 3. Design

### 3.1 AI layer

**Thread brief.** New JSONB column `threads.brief`: `{ summary: string | null, facts: object, updated_at: timestamptz }`.

- Writes:
  - The `extract` handler writes extracted variables into `brief.facts` as well as the run context bag (deterministic, no added AI cost).
  - `summary` is regenerated lazily: only when the thread exceeds ~8 messages AND the brief is stale (older than the latest message) at the moment an AI call needs it. Short threads never pay for summarisation.
- Reads: every judgment-type AI call (composer, evaluate, triage) receives a `THREAD BRIEF` block (facts plus summary when present).
- Seeding: `startRun` initialises the new run's context bag from `brief.facts`. A thread that legitimately gets a second run (recategorised, or the customer returns weeks later) starts already knowing what it knew. Context loss becomes structurally impossible, not just patched in one code path.

**Unified reply composer.** New module `api/services/playbook/composer.ts`, called by both `ask_customer` and `send_reply` handlers, replacing their divergent prompt builders. Always assembles:

- goal, voice/writing style, sender name, signature, store profile
- thread brief (facts + summary)
- the run's full context bag
- the full transcript, with a cap: threads over ~30 messages get the brief summary plus the last 10 messages in full
- previously-sent messages on the current step (anti-repetition, as today)

The handlers keep their distinct decision shapes (`ask_customer`: ask/skip/escalate JSON; `send_reply`: plain body). Only context assembly and shared rules unify. One shared `isPresent()` replaces the two inconsistent variable-presence checks (`== null` in ask_customer vs `=== null || === undefined || === ""` in evaluate); empty string counts as absent.

`evaluate` and `triage` also switch from sliced transcripts to the same capped-transcript helper the composer uses.

### 3.2 Reliability layer

**Run lifecycle: a new inbound message never destroys an active run.** Rule: a thread with any non-terminal run is never recategorised. Per state, inbound now does:

- `waiting_for_customer`: resume into the run (unchanged).
- `waiting_for_human`: run stays waiting. Message attaches to the run; the approval surfaces flag "customer replied since this draft was written" and offer one-click draft regeneration (composer re-run with the updated transcript). Nothing is cancelled without a human seeing it.
- `waiting_to_send`: the queued send is dropped as stale; the run re-enters the send step, recomposes with the new message in view, and re-queues the delayed send.
- `retrying` / `running`: no special handling beyond not cancelling. `advanceRun` reloads the full transcript on every advance, so the new message is naturally in view when the run proceeds.

Accepted trade-off: the old nuke-and-recategorise behaviour could incidentally catch a mid-thread topic change. We rely instead on the composer/evaluate seeing the new message (and escalating when confused), and on the draft-first ramp putting a human in front of every reply early on. This is a deliberate decision.

**Status taxonomy.** New handler decision type `escalate` (distinct from `fail`), mapped by the executor to `status='escalated'`, with the actual cause written to `escalation_reason` and the `run_escalated` alert fired. Adopted by: `escalate` steps, the AI escalate paths in `ask_customer`/`evaluate`, human rejections (both flows converge here), and worker-driven timeouts. `failed` becomes reserved for genuine errors.

**Wedge-proofing.**
- `advanceRun` setup (thread/playbook/token loads) gets error handling: structural failure marks the run `failed` with the error recorded and alerts, instead of propagating uncaught and leaving `running` forever.
- The swallowed `startRun` catch in `categorisation.ts` now sets the thread to `in_review` and alerts.
- `failed_ingestions` DLQ exhaustion (3 attempts) alerts.
- All new transitions publish on the existing SSE event bus.

### 3.3 Product layer

**Review queue as the manual-reply home.**
- `/review` gets a sidebar nav entry with a live badge count, SSE subscription (currently load-once), and a conflict guard: approving/rejecting an already-actioned run returns a conflict and the UI refreshes gracefully.
- One draft model everywhere: the legacy `drafts`-table flow retires from the UI; playbook pending-sends (editable, with "reset to AI draft") are the single model on both the thread page and the queue. Legacy `drafts` data is checked in prod before endpoint removal.
- `/sheet-updates` and `/sheet-rules` get links under System for discoverability. The sheet-rules-to-playbooks migration remains deferred.

**Human-looking replies.**
- Outbound MIME gets a `From` display name (the store name) alongside the address.
- The configured signature applies consistently to AI and manual replies.
- Customer attachments appear in the transcript as markers (`[attachment: photo.jpg]`) so the composer can acknowledge them.

**Trust ramp.**
- Per category: count consecutive approved-without-edit drafts. Editing or rejecting resets the streak. (Stored on the category's playbook, which is one-to-one with category per migration 024.)
- At the target (default 10), the category flips to auto-send, announced in the UI with one-click revert.
- Queue/category UI shows streak progress (e.g. "7/10 clean approvals").

## 4. Data model changes

Sequential, append-only migrations (next: 028):

- `threads.brief JSONB` (default `'{}'`).
- Playbook/category ramp fields: `auto_send_streak_target INT` (default 10) and `approval_streak INT` (default 0) on `playbooks` (reply_mode already lives there).
- No changes to `playbook_runs` statuses (the `escalate` decision maps onto the existing `escalated` status).

## 5. Error handling summary

- Every escalation path: `status='escalated'`, true reason, alert.
- Every structural failure: `status='failed'`, error recorded, alert, thread visible in review. No silent catches, no wedged `running` runs.
- Conflict on double-approve/reject: explicit conflict response, UI refresh.
- SSE events on all state transitions.

## 6. Testing and verification

- TDD per repo standards (failing test first) for: each paused-state x inbound-message lifecycle case, escalation status mapping, brief write/read/seed paths, composer context assembly (snapshot the prompt blocks), `isPresent()` semantics, streak logic.
- Dry-run harness: extend to simulate a mid-run customer reply; fix it to use `getModel(workspaceId)` instead of hardcoded `gpt-4o` (same fix in `parser.ts` call sites where appropriate).
- Prod grounding (once access lands): sample ~20 real threads including failed/stuck runs and sent AI replies; confirm failures trace to the four defect clusters; keep the samples as a before/after reply-quality benchmark.
- UI verification via Playwright per repo convention; data verification via postgres MCP after writes.

## 7. Rollout

1. Ship with every category forced to draft-only (safe by construction).
2. Soak on real traffic behind the review queue; Fabien/Kieran watch reply quality for about a week.
3. Categories graduate to auto-send via the streak mechanism, starting with low-risk types (tracking).
4. Refunds/complaints can stay draft-only indefinitely; that is a feature, not a failure.

## 8. Deferred / out of scope this round

- Shopify Admin API order lookups (design keeps a clean seam: a future `find_order` step can write into `brief.facts` like `find_sheet_row` does).
- Sheet-rules system migration into playbooks (and dropping those tables).
- `categories.name` global-unique constraint fix (latent multi-tenant bug; single tenant today; logged).
- Provider changes; per-call-type model routing.
- Attachment content understanding (we mark presence only).

## 9. Documentation debt paid alongside

- `CLAUDE.md` known-issues list refreshed to current truth.
- `docs/PLAYBOOK_ENGINE.md`: add the `triage` step, remove the deleted legacy auto-draft branch from the flow diagram.
- `docs/TASK_LOG.md`: entries per implementation phase, as the repo convention requires.
