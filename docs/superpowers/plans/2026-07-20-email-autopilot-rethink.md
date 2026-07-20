# E-com Autopilot Rethink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI reply engine context-complete and reliable so most of Kieran's store email is handled end to end, with a trustworthy review queue for the rest.

**Architecture:** Keep the existing playbook engine. Add a thread-level memory (brief) and a unified reply composer (Tasks 1-4), make runs survive mid-run inbound mail and give escalations a real status taxonomy (Tasks 5-8), then wire the review queue, human-looking replies, and the draft-to-auto trust ramp into the product (Tasks 9-13).

**Tech Stack:** Deno + Hono (TypeScript), Postgres 16, SvelteKit 5 (runes), Gmail REST v1, Google Sheets REST v4, OpenAI Chat Completions via the existing `chatCompletion` wrapper.

**Spec:** `docs/superpowers/specs/2026-07-20-email-autopilot-rethink-design.md` (approved 2026-07-20).

## Global Constraints

- Migrations: append-only, next file is `api/db/migrations/028_thread_brief_and_streaks.sql`; `BEGIN; ... COMMIT;` wrapper, `IF NOT EXISTS` on creates, TEXT CHECK over ENUM, JSONB over JSON.
- All multi-statement DB writes use `transaction()` from `api/db/client.ts`; every query on workspace-owned data filters by `workspace_id` (threads are trusted PK-scoped once loaded).
- All OpenAI calls go through `chatCompletion` in `api/services/ai.ts`, model resolved via `getModel(workspaceId)`; no other AI wrappers, no provider change.
- Known errors: `throw new AppError(message, status)`. Routes stay thin; logic lives in services. No fire-and-forget without an alert or documented justification.
- Frontend: SvelteKit 5 runes only (`$state`, `$derived`, `$effect`, `$props`); API calls through `frontend/src/lib/api.ts`; CSS variables from `+layout.svelte`, component-scoped styles, no Tailwind; loading/error/content states on data-fetching pages.
- No new dependencies anywhere.
- TDD: failing test first wherever a test is possible. Pure-function extraction is this repo's testing pattern (see `handlers/triage.ts`); follow it. API test command: `cd api && deno test --allow-net --allow-env --allow-read`. DB-backed integration tests additionally require the local stack up (`docker compose up -d postgres`) and `DATABASE_URL` (plus `API_SECRET` for route tests) exported in the shell.
- Frontend has no unit-test harness: verify UI steps via Playwright MCP exactly as written in each step, and `cd frontend && npm run check` must pass.
- No em dashes in any output: code, comments, docs, commit messages. Use commas, colons, or restructure.
- After each task: update `docs/TASK_LOG.md` only where a task says so; commit messages are short imperative with no attribution footers.
- Rollout guard: nothing in these tasks may flip any category to auto-send by itself; every category ships draft-only and graduates only via the Task 12 streak mechanism.

---

# Email Autopilot Rethink - Phase 1 (AI Layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement section 3.1 (AI layer) and its section 4 data model from `docs/superpowers/specs/2026-07-20-email-autopilot-rethink-design.md`: a durable per-thread brief (facts + lazy summary) that survives across runs, and a single composer module that unifies prompt-context assembly for `ask_customer` and `send_reply`, replacing their divergent, context-starved prompt builders.

**Architecture:** One new migration adds `threads.brief JSONB` plus two playbook trust-ramp columns (unused until a later phase). `brief.ts` owns reading/writing that column. `context-utils.ts` centralises the one variable-presence check and the transcript-capping rule every AI-facing step should share. `composer.ts` sits on top of both and becomes the only place `ask_customer.ts` and `send_reply.ts` build prompts. `evaluate.ts` and `triage.ts` adopt the capped-transcript helper without adopting the full composer (they are routing decisions, not customer-facing writing).

**Tech Stack:** Deno + Hono (TypeScript, strict), Postgres 16 via `deno-postgres`, OpenAI GPT-4o via the existing `chatCompletion` wrapper, Deno's built-in test runner (`deno test`), `https://deno.land/std@0.224.0/assert/mod.ts` for assertions.

## Global Constraints

- All multi-statement DB writes use `transaction()` from `api/db/client.ts`. (Every write in this plan is a single UPDATE/INSERT statement, so none needs it - noted per task where relevant.)
- Every query on workspace-owned data filters by `workspace_id`, **except** single-row reads/writes keyed by an already-trusted primary key obtained from a workspace-scoped context (e.g. `WHERE id = $1` on a `threadId` sourced from `ctx.threadId`) - this matches the existing precedent throughout `api/services/playbook/executor.ts` (`UPDATE threads SET status = ... WHERE id = $1`, no `workspace_id` filter).
- OpenAI calls go through `chatCompletion` in `api/services/ai.ts`. No other wrapper, no direct `fetch` to OpenAI.
- Google API calls go through `getGoogleAccessToken` (not touched by this plan).
- No fire-and-forget without explicit justification - every DB/AI call in this plan is `await`ed.
- Routes stay thin; logic lives in services (not touched by this plan - no route changes).
- Throw `AppError(statusCode, message, detail?)` for known errors - this is the constructor's *actual* order in `api/types/index.ts:280-289` (`class AppError extends Error { constructor(public readonly statusCode: number, message: string, public readonly detail?: string) }`), used exactly this way throughout `api/services/ai.ts`. Follow the real code, not the shorthand `AppError(message, status)` phrasing.
- Migrations: append-only, `BEGIN; ... COMMIT;`, `ADD COLUMN IF NOT EXISTS`, `TEXT CHECK` over enum, `JSONB` over `JSON`, a `-- Why this exists / Touches tables / Destructive` header comment (house style confirmed in `api/db/migrations/024_playbook_unique_per_category.sql`, `026_reply_delay.sql`, `027_playbook_run_steps_snapshot.sql`). Next migration number is `028` (latest applied is `027`).
- Test command (confirmed from `api/deno.json` and a clean run: 14 tests, 0 failures, ~164ms): `cd api && deno test --allow-net --allow-env --allow-read`. Target a single file by appending its path, e.g. `deno test --allow-net --allow-env --allow-read services/playbook/brief_test.ts`.
- Compile check: `cd api && deno check main.ts`.
- No em dashes anywhere in code, comments, commit messages, or this document. Use a comma, colon, or restructure the sentence.
- Comments explain WHY, not WHAT. Senior-level naming. No `any` without justification, no unexplained `as` casts.
- Commit messages: short imperative, no attribution footers.

---

## PRODUCED INTERFACES (what later phases consume)

**Migration `028_thread_brief_and_streaks.sql`** (Task 1):
- `threads.brief JSONB NOT NULL DEFAULT '{}'`
- `playbooks.auto_send_streak_target INT NOT NULL DEFAULT 10 CHECK (auto_send_streak_target > 0)`
- `playbooks.approval_streak INT NOT NULL DEFAULT 0 CHECK (approval_streak >= 0)`

**`api/services/playbook/brief.ts`** (Task 1):
```ts
export type ThreadBrief = { summary: string | null; facts: Record<string, unknown>; updated_at: string | null };
export async function getThreadBrief(threadId: number): Promise<ThreadBrief>
export async function mergeBriefFacts(threadId: number, facts: Record<string, unknown>): Promise<void>
export async function ensureBriefSummary(workspaceId: number, threadId: number, messages: Message[]): Promise<string | null>
export function shouldRegenerateSummary(messages: Message[], brief: ThreadBrief): boolean  // see deviation note in Task 1
```

**`api/services/playbook/context-utils.ts`** (Task 3):
```ts
export function isPresent(value: unknown): boolean
export function formatCappedTranscript(messages: Message[], summary: string | null): string
export function formatBriefBlock(brief: ThreadBrief): string
```

**`api/services/playbook/composer.ts`** (Task 4):
```ts
export type AiCall = { model: string; prompt: string; response: string; tokens?: number };
export type ComposerInputs = { ctx: RunContext; goal: string; voice: string | undefined; requiredContext: string[]; priorSent: string[] };
export type AskDecision = { action: "ask"; message: string } | { action: "skip"; extracted: Record<string, unknown> } | { action: "escalate"; reason: string };
export function assembleComposerContext(inputs: ComposerInputs, brief: ThreadBrief, summary: string | null): string  // see deviation note in Task 4
export async function buildComposerContext(inputs: ComposerInputs): Promise<string>
export async function composeAskDecision(inputs: ComposerInputs): Promise<{ decision: AskDecision; aiCall: AiCall }>
export async function composeReplyBody(inputs: ComposerInputs & { referenceContext: Record<string, unknown> }): Promise<{ body: string; aiCall: AiCall }>
```

`AiCall` reuses the exact element shape `ask_customer.ts`/`send_reply.ts`/every other AI-calling handler already pushes into `StepResult.aiCalls` today (`{ model, prompt, response, tokens: undefined }`, inline in `StepResult.aiCalls?: Array<{ model: string; prompt: string; response: string; tokens?: number }>` in `api/services/playbook/types.ts`). `types.ts` does not declare a standalone named type for it today, so `AiCall` is defined once in `composer.ts` rather than duplicated; it is structurally identical to `StepResult.aiCalls`'s element type, so `aiCalls: [aiCall]` type-checks without any change to `types.ts`.

**`api/services/playbook/types.ts`** (Task 4, widened): `RunContext.messages` changes from a bespoke inline array type to `Message[]` (imported from `api/types/index.ts`), so every consumer of `ctx.messages` now works with the canonical `Message` type across the codebase.

`Message` itself is the existing `api/types/index.ts:45-55` interface (`id, thread_id, gmail_message_id, from_address, body_plain, body_html, received_at, direction, message_id_header`) - not a new type.

---

### Task 1: Migration 028 + thread brief service

**Files:**
- Create: `api/db/migrations/028_thread_brief_and_streaks.sql`
- Create: `api/services/playbook/brief.ts`
- Test: `api/services/playbook/brief_test.ts`

**Interfaces:**
- Consumes: `execute`, `queryOne` from `api/db/client.ts:29-51,57-67`; `AppError`, `Message` from `api/types/index.ts:45-55,280-289`; `chatCompletion`, `getModel` from `api/services/ai.ts:21-27,109-195`; `formatTranscript` from `api/services/email-text.ts:73-75`; `getStoreProfile` from `api/services/store-profile.ts:9-23`.
- Produces: `ThreadBrief`, `getThreadBrief`, `mergeBriefFacts`, `ensureBriefSummary`, `shouldRegenerateSummary` (see PRODUCED INTERFACES above). Task 2 consumes `getThreadBrief` and `mergeBriefFacts`. Task 4 consumes `getThreadBrief` and `ensureBriefSummary`.

**Deviation flag:** the spec says brief.ts exports "exactly" the 4 signatures (`ThreadBrief`, `getThreadBrief`, `mergeBriefFacts`, `ensureBriefSummary`). This task additionally exports `shouldRegenerateSummary`, the pure lazy-regeneration decision that `ensureBriefSummary` delegates to. Reason: `getThreadBrief`/`mergeBriefFacts`/`ensureBriefSummary` all touch Postgres (and `ensureBriefSummary` touches OpenAI too), and this repo has zero DB-mocking or AI-mocking test infrastructure today (verified: none of the 4 existing `*_test.ts` files touch the DB or network; `triage_test.ts` only tests the pure `resolveTriageDecision`, never the DB/AI-touching `triageHandler`). Exporting the one genuinely pure piece of business logic here mirrors that exact `resolveTriageDecision` / `triageHandler` split already established in `api/services/playbook/handlers/triage.ts`, and is the only way to give this lazy-regeneration rule a real failing-test-first cycle per repo TDD convention.

- [ ] **Step 1: Write the migration file**

`api/db/migrations/028_thread_brief_and_streaks.sql`:

```sql
-- 028_thread_brief_and_streaks.sql
-- Why this exists: AI reply/evaluate/triage prompts only see the last few
-- messages even though the full thread is loaded, and a second run on the
-- same thread (recategorised, or the customer returns weeks later) starts
-- from an empty context bag, silently losing everything an earlier run
-- learned. threads.brief gives every run a durable, thread-scoped memory
-- (extracted facts plus a lazily regenerated summary) that startRun seeds
-- new runs from. The two playbooks columns support the per-category
-- auto-send trust ramp (a later phase): count consecutive clean approvals
-- and compare against a target before flipping reply_mode.
-- Touches tables: threads, playbooks
-- Destructive: no

BEGIN;

ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS brief JSONB NOT NULL DEFAULT '{}';

ALTER TABLE playbooks
  ADD COLUMN IF NOT EXISTS auto_send_streak_target INT NOT NULL DEFAULT 10
    CHECK (auto_send_streak_target > 0),
  ADD COLUMN IF NOT EXISTS approval_streak INT NOT NULL DEFAULT 0
    CHECK (approval_streak >= 0);

COMMIT;
```

- [ ] **Step 2: Apply the migration locally and verify the columns**

```bash
docker compose up -d postgres
cd api && DATABASE_URL=postgres://emaildash:changeme@localhost:5432/emaildash deno task migrate
```

Expected output: `[migrate] Applied 1 migration(s) successfully.`

Verify via the postgres MCP (or `docker compose exec -T postgres psql -U emaildash -d emaildash -c "..."`):

```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'threads' AND column_name = 'brief';
```

Expected: one row, `data_type = jsonb`, `column_default = '{}'::jsonb`.

```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'playbooks' AND column_name IN ('auto_send_streak_target', 'approval_streak');
```

Expected: two rows, `integer`, defaults `10` and `0`.

- [ ] **Step 3: Commit the migration**

```bash
git add api/db/migrations/028_thread_brief_and_streaks.sql
git commit -m "Add threads.brief and playbook streak columns"
```

- [ ] **Step 4: Write the failing test for the lazy-regeneration rule**

`api/services/playbook/brief_test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { shouldRegenerateSummary } from "./brief.ts";
import type { ThreadBrief } from "./brief.ts";
import type { Message } from "../../types/index.ts";

function makeMessages(count: number, latestReceivedAt: Date): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    thread_id: 1,
    gmail_message_id: `gmail-${i + 1}`,
    from_address: "customer@example.com",
    body_plain: `message ${i + 1}`,
    body_html: "",
    received_at: i === count - 1
      ? latestReceivedAt
      : new Date(latestReceivedAt.getTime() - (count - i) * 60_000),
    direction: "inbound" as const,
    message_id_header: null,
  }));
}

const emptyBrief: ThreadBrief = { summary: null, facts: {}, updated_at: null };

Deno.test("shouldRegenerateSummary is false for threads at or under 8 messages, regardless of brief state", () => {
  const messages = makeMessages(8, new Date("2026-07-20T12:00:00Z"));
  assertEquals(shouldRegenerateSummary(messages, emptyBrief), false);
});

Deno.test("shouldRegenerateSummary is true for a long thread with no existing summary", () => {
  const messages = makeMessages(9, new Date("2026-07-20T12:00:00Z"));
  assertEquals(shouldRegenerateSummary(messages, emptyBrief), true);
});

Deno.test("shouldRegenerateSummary is true when the brief predates the latest message", () => {
  const messages = makeMessages(12, new Date("2026-07-20T12:00:00Z"));
  const staleBrief: ThreadBrief = {
    summary: "Old summary",
    facts: {},
    updated_at: "2026-07-20T11:00:00Z",
  };
  assertEquals(shouldRegenerateSummary(messages, staleBrief), true);
});

Deno.test("shouldRegenerateSummary is false when the brief is newer than the latest message", () => {
  const messages = makeMessages(12, new Date("2026-07-20T12:00:00Z"));
  const freshBrief: ThreadBrief = {
    summary: "Fresh summary",
    facts: {},
    updated_at: "2026-07-20T12:30:00Z",
  };
  assertEquals(shouldRegenerateSummary(messages, freshBrief), false);
});
```

- [ ] **Step 5: Run the test and verify it fails**

```bash
cd api && deno test --allow-net --allow-env --allow-read services/playbook/brief_test.ts
```

Expected: fails to run - `error: Module not found "file:///.../api/services/playbook/brief.ts"`.

- [ ] **Step 6: Implement `brief.ts`**

`api/services/playbook/brief.ts`:

```ts
/**
 * Thread brief - durable, thread-scoped AI memory.
 *
 * Every playbook run advancing a thread learns things (extracted variables,
 * a rolling summary of the conversation). Without a shared store, that
 * knowledge lived only in the run's own context bag and vanished the moment
 * a second run started on the same thread (recategorisation, or the
 * customer returning weeks later). threads.brief fixes that: extract writes
 * facts here as it goes, and startRun seeds a new run's context from it, so
 * context loss becomes structurally impossible instead of something patched
 * in one code path.
 */
import { execute, queryOne } from "../../db/client.ts";
import { AppError, Message } from "../../types/index.ts";
import { chatCompletion, getModel } from "../ai.ts";
import { formatTranscript } from "../email-text.ts";
import { getStoreProfile } from "../store-profile.ts";

export type ThreadBrief = {
  summary: string | null;
  facts: Record<string, unknown>;
  updated_at: string | null;
};

interface ThreadBriefRow {
  brief: Partial<ThreadBrief> | string | null;
}

// Below this message count a thread is short enough that the full transcript
// is cheap to send on every AI call - summarising it would cost tokens
// without saving any.
const SUMMARY_MIN_MESSAGES = 8;

/**
 * Read a thread's brief. Always returns a fully-populated ThreadBrief, even
 * for a thread that has never had one written (the migration default is
 * '{}', so summary/facts/updated_at all come back empty rather than every
 * caller having to null-check the whole object).
 */
export async function getThreadBrief(threadId: number): Promise<ThreadBrief> {
  const row = await queryOne<ThreadBriefRow>(
    "SELECT brief FROM threads WHERE id = $1",
    [threadId],
  );
  if (!row) {
    throw new AppError(404, `Thread ${threadId} not found`);
  }

  // deno-postgres sometimes hands back a JSONB column as a string rather
  // than a pre-parsed object depending on how the row was fetched -
  // executor.ts's run.context has the same quirk, so mirror its guard here.
  const raw = typeof row.brief === "string" ? JSON.parse(row.brief) : (row.brief ?? {});

  return {
    summary: raw.summary ?? null,
    facts: raw.facts ?? {},
    updated_at: raw.updated_at ?? null,
  };
}

/**
 * Merge new facts into a thread's brief, preserving keys already there that
 * aren't part of this update. Deterministic and cheap - called after every
 * extract step, no AI cost. Deliberately never touches `updated_at`: that
 * field tracks summary freshness (see shouldRegenerateSummary below), and a
 * fact merge happening in the same run that just read the thread's messages
 * must not make a stale summary look fresh.
 *
 * threadId is not re-scoped by workspace_id here: it is already a trusted,
 * globally unique primary key sourced from a workspace-scoped RunContext by
 * every caller, matching the same WHERE id = $1 pattern executor.ts already
 * uses for single-row thread updates.
 */
export async function mergeBriefFacts(
  threadId: number,
  facts: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(facts).length === 0) return;

  await execute(
    `UPDATE threads
     SET brief = jsonb_set(brief, '{facts}', COALESCE(brief->'facts', '{}'::jsonb) || $2::jsonb, true)
     WHERE id = $1`,
    [threadId, JSON.stringify(facts)],
  );
}

/**
 * Pure decision logic for whether ensureBriefSummary needs to pay for a
 * chatCompletion call. Exported beyond the four signatures the AI layer
 * spec calls for, purely so this one piece of real business logic gets a
 * TDD cycle without touching Postgres or OpenAI - mirrors the
 * resolveTriageDecision / triageHandler split already used in triage.ts.
 */
export function shouldRegenerateSummary(messages: Message[], brief: ThreadBrief): boolean {
  if (messages.length <= SUMMARY_MIN_MESSAGES) return false;

  const latest = messages[messages.length - 1];
  const latestReceivedAt = latest.received_at instanceof Date
    ? latest.received_at
    : new Date(latest.received_at);

  if (!brief.updated_at) return true;
  return new Date(brief.updated_at) <= latestReceivedAt;
}

/**
 * Return the thread's summary, regenerating it first if the thread has
 * grown past the point a full transcript is cheap to send and the existing
 * summary (if any) predates the latest message. Short threads never pay for
 * summarisation; long, quiet threads reuse the cached summary indefinitely.
 */
export async function ensureBriefSummary(
  workspaceId: number,
  threadId: number,
  messages: Message[],
): Promise<string | null> {
  const brief = await getThreadBrief(threadId);

  if (!shouldRegenerateSummary(messages, brief)) {
    return brief.summary;
  }

  const [storeProfile, model] = await Promise.all([
    getStoreProfile(workspaceId),
    getModel(workspaceId),
  ]);

  const prompt =
    `You maintain a running summary of an email support thread so other AI steps have shared memory of what happened earlier in a long conversation.
${storeProfile ? `\nStore context:\n${storeProfile}\n` : ""}
Summarise the conversation below in 2-4 sentences: what the customer wants, what has been established, offered, or promised, and where things currently stand. Plain text only, no markdown, no greeting or signature.

Thread transcript:
${formatTranscript(messages)}`;

  const response = await chatCompletion([{ role: "user", content: prompt }], model);
  const summary = response.trim();

  await execute(
    `UPDATE threads
     SET brief = jsonb_set(jsonb_set(brief, '{summary}', to_jsonb($2::text)), '{updated_at}', to_jsonb($3::text))
     WHERE id = $1`,
    [threadId, summary, new Date().toISOString()],
  );

  return summary;
}
```

- [ ] **Step 7: Run the test and verify it passes**

```bash
cd api && deno test --allow-net --allow-env --allow-read services/playbook/brief_test.ts
```

Expected: `ok | 4 passed | 0 failed`.

- [ ] **Step 8: Verify `getThreadBrief` and `mergeBriefFacts` against local Postgres**

With `docker compose up -d postgres` still running, use the postgres MCP (or psql) to create a scratch thread, then a scratch Deno script to exercise the DB-touching functions (no unit test possible for these without DB-mocking infrastructure this repo doesn't have - see the deviation note above the steps):

```sql
INSERT INTO threads (workspace_id, gmail_thread_id, subject)
VALUES (1, 'brief-verify-thread', 'Brief verification')
ON CONFLICT (gmail_thread_id) DO NOTHING
RETURNING id;
```

Note the returned `id` (call it `<id>`), then:

```bash
cd api && DATABASE_URL=postgres://emaildash:changeme@localhost:5432/emaildash deno run --allow-net --allow-env --allow-read - <<'EOF'
import { getThreadBrief, mergeBriefFacts } from "./services/playbook/brief.ts";

const threadId = <id>; // replace with the id from the INSERT above
console.log("before:", await getThreadBrief(threadId));
await mergeBriefFacts(threadId, { order_number: "4521" });
await mergeBriefFacts(threadId, { customer_name: "Kadin" });
console.log("after two merges:", await getThreadBrief(threadId));
EOF
```

Expected: `before` shows `{ summary: null, facts: {}, updated_at: null }`; `after two merges` shows `facts: { order_number: "4521", customer_name: "Kadin" }` with both keys present (proving the merge preserves earlier keys) and `summary`/`updated_at` still `null` (proving the merge never touches them). Clean up the scratch row afterward: `DELETE FROM threads WHERE gmail_thread_id = 'brief-verify-thread';`.

- [ ] **Step 9: Commit**

```bash
git add api/services/playbook/brief.ts api/services/playbook/brief_test.ts
git commit -m "Add thread brief service with lazy summary regeneration"
```

---

### Task 2: Brief integration into the run lifecycle

**Files:**
- Modify: `api/services/playbook/handlers/extract.ts` (full file, 67 lines)
- Modify: `api/services/playbook/executor.ts:620-644` (`startRun`)

**Interfaces:**
- Consumes: `mergeBriefFacts(threadId: number, facts: Record<string, unknown>): Promise<void>` and `getThreadBrief(threadId: number): Promise<ThreadBrief>` from Task 1's `api/services/playbook/brief.ts`.
- Produces: nothing new. `startRun`'s `RunResult` return shape is unchanged; only the seeded `context` value changes.

- [ ] **Step 1: Modify `extract.ts` to persist extracted facts to the brief**

No unit test for this step: `extractHandler.execute` touches `chatCompletion` and now `mergeBriefFacts` (Postgres), and this repo has no DB/AI mocking infrastructure (matches the existing convention - `extract.ts` has no test file today either). Verified instead via `deno check` (Step 2) and a manual Postgres check (Step 3), per CLAUDE.md's explicit allowance to skip TDD when genuinely necessary and say so.

Replace the full contents of `api/services/playbook/handlers/extract.ts`:

```ts
/**
 * Extract handler - uses AI to pull named variables from the thread messages.
 */
import type { ExtractStep, PlaybookStep, RunContext, StepHandler, StepResult } from "../types.ts";
import { chatCompletion, getModel } from "../../ai.ts";
import { formatTranscript } from "../../email-text.ts";
import { mergeBriefFacts } from "../brief.ts";

export const extractHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const extractStep = step as ExtractStep;
    const variables = extractStep.variables;

    const transcript = formatTranscript(ctx.messages);

    const model = await getModel(ctx.workspaceId);

    const prompt = `You are extracting specific pieces of information from an email thread.
${
      ctx.storeProfile
        ? `\nStore context for interpreting domain-specific terms:\n${ctx.storeProfile}\n`
        : ""
    }
Extract the following variables from the thread: ${variables.join(", ")}

Thread transcript:
${transcript}

Respond with a JSON object where keys are the variable names and values are the extracted values.
If a variable cannot be found in the thread, set its value to null.

Example response for variables ["order_number", "customer_name"]:
{"order_number": "12345", "customer_name": "John Smith"}`;

    const response = await chatCompletion(
      [{ role: "user", content: prompt }],
      model,
      { type: "json_object" },
    );

    const aiCalls = [{ model, prompt, response, tokens: undefined }];

    let extracted: Record<string, unknown>;
    try {
      extracted = JSON.parse(response);
    } catch {
      return {
        decision: { action: "fail", error: "Failed to parse AI extraction response" },
        aiCalls,
      };
    }

    // Only keep the variables we asked for
    const contextUpdates: Record<string, unknown> = {};
    for (const v of variables) {
      if (v in extracted) {
        contextUpdates[v] = extracted[v];
      }
    }

    // Persist known facts to the thread's brief so they outlive this run - a
    // later run on the same thread seeds its context from brief.facts via
    // startRun. Only genuinely-found values are written: a null here means
    // "not found in this run's messages", not "this fact no longer holds",
    // and must not overwrite something an earlier run already established.
    const knownFacts = Object.fromEntries(
      Object.entries(contextUpdates).filter(([, value]) => value !== null && value !== undefined),
    );
    await mergeBriefFacts(ctx.threadId, knownFacts);

    return {
      decision: { action: "advance" },
      output: extracted,
      contextUpdates,
      aiCalls,
    };
  },
};
```

- [ ] **Step 2: Compile-check**

```bash
cd api && deno check main.ts
```

Expected: no output, exit code 0.

- [ ] **Step 3: Modify `startRun` to seed context from `brief.facts`**

In `api/services/playbook/executor.ts`, add the import near the top (after the existing `getStoreProfile` import on line 11):

```ts
import { getStoreProfile } from "../store-profile.ts";
import { getThreadBrief } from "./brief.ts";
```

Then replace the body of `startRun` (currently lines 620-644):

```ts
export async function startRun(
  workspaceId: number,
  threadId: number,
  playbookId: number,
): Promise<RunResult> {
  const playbook = await queryOne<Playbook>(
    "SELECT * FROM playbooks WHERE id = $1",
    [playbookId],
  );
  if (!playbook) throw new Error(`Playbook ${playbookId} not found`);

  const steps: PlaybookStep[] = typeof playbook.steps === "string"
    ? JSON.parse(playbook.steps)
    : playbook.steps;

  const firstStepId = steps.length > 0 ? steps[0].id : null;

  // Seed the run's context bag from the thread's brief facts. A thread that
  // gets a second run - recategorised, or the customer returns weeks later -
  // starts already knowing what an earlier run learned, instead of from '{}'.
  const brief = await getThreadBrief(threadId);

  const row = await queryOne<{ id: number }>(
    `INSERT INTO playbook_runs (workspace_id, thread_id, playbook_id, playbook_version, steps_snapshot, current_step_id, status, context)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'running', $7::jsonb)
     RETURNING id`,
    [
      workspaceId,
      threadId,
      playbookId,
      playbook.version,
      JSON.stringify(steps),
      firstStepId,
      JSON.stringify(brief.facts),
    ],
  );

  if (!row) throw new Error("Failed to create playbook run");

  logger.info("playbook.run_created", {
    run_id: row.id,
    thread_id: threadId,
    playbook_name: playbook.name,
    version: playbook.version,
  });
  return advanceRun(row.id);
}
```

This keeps `steps_snapshot` behavior completely intact (still populated from `JSON.stringify(steps)` at creation time, still immutable for the run's lifetime) - only the `context` value changes from the literal `'{}'` to the thread's current `brief.facts`.

- [ ] **Step 4: Compile-check and run the full suite**

```bash
cd api && deno check main.ts && deno test --allow-net --allow-env --allow-read
```

Expected: `deno check` produces no output; `deno test` reports `ok | 14 passed | 0 failed` (unchanged - no new unit-testable surface was added in this task).

- [ ] **Step 5: Verify `startRun` seeding against local Postgres**

With a thread that already has `brief.facts` populated (e.g. the one used in Task 1 Step 8, or run `mergeBriefFacts` again on a fresh scratch thread), start a run against any existing playbook and confirm the new run's `context` column starts with those facts already present:

```sql
SELECT id, context FROM playbook_runs WHERE thread_id = <id> ORDER BY created_at DESC LIMIT 1;
```

Expected: `context` contains the same keys that were in `threads.brief -> 'facts'` for that thread at the moment the run was created.

- [ ] **Step 6: Commit**

```bash
git add api/services/playbook/handlers/extract.ts api/services/playbook/executor.ts
git commit -m "Seed run context from thread brief and persist extracted facts to it"
```

---

### Task 3: Shared context utilities

**Files:**
- Create: `api/services/playbook/context-utils.ts`
- Test: `api/services/playbook/context-utils_test.ts`
- Modify: `api/services/playbook/handlers/ask_customer.ts:16,83`
- Modify: `api/services/playbook/handlers/evaluate.ts:12-14,24-27`

**Interfaces:**
- Consumes: `formatTranscript` from `api/services/email-text.ts:73-75`; `Message` from `api/types/index.ts:45-55`; `ThreadBrief` (type only) from Task 1's `api/services/playbook/brief.ts`.
- Produces: `isPresent(value: unknown): boolean`, `formatCappedTranscript(messages: Message[], summary: string | null): string`, `formatBriefBlock(brief: ThreadBrief): string`. Task 4 consumes all three (`isPresent` in `send_reply.ts` and inside `composer.ts`'s assembly; `formatCappedTranscript` inside `composer.ts`, `evaluate.ts`, and `triage.ts`; `formatBriefBlock` inside `evaluate.ts` and `triage.ts`, so those two judgment steps see the same facts/summary block the composer already assembles inline).

- [ ] **Step 1: Write the failing tests**

`api/services/playbook/context-utils_test.ts`:

```ts
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatBriefBlock, formatCappedTranscript, isPresent } from "./context-utils.ts";
import type { Message } from "../../types/index.ts";
import type { ThreadBrief } from "../brief.ts";

function makeMessage(id: number): Message {
  return {
    id,
    thread_id: 1,
    gmail_message_id: `gmail-${id}`,
    from_address: "customer@example.com",
    body_plain: `message ${id}`,
    body_html: "",
    received_at: new Date(2026, 0, 1, 0, 0, id),
    direction: "inbound",
    message_id_header: null,
  };
}

Deno.test("isPresent treats null and undefined as absent", () => {
  assertEquals(isPresent(null), false);
  assertEquals(isPresent(undefined), false);
});

Deno.test("isPresent treats empty and whitespace-only strings as absent - the ask_customer behaviour change", () => {
  // ask_customer previously used `== null`, which treated "" as present and
  // would skip asking the customer for a var that was extracted as an empty
  // string. isPresent closes that gap: "" now counts as missing.
  assertEquals(isPresent(""), false);
  assertEquals(isPresent("   "), false);
});

Deno.test("isPresent treats 0 and false as present", () => {
  assertEquals(isPresent(0), true);
  assertEquals(isPresent(false), true);
});

Deno.test("isPresent treats non-empty strings and objects as present", () => {
  assertEquals(isPresent("12345"), true);
  assertEquals(isPresent({ a: 1 }), true);
});

Deno.test("formatCappedTranscript returns the full transcript at or under 30 messages", () => {
  const messages = Array.from({ length: 30 }, (_, i) => makeMessage(i + 1));
  const result = formatCappedTranscript(messages, "irrelevant summary");

  assertStringIncludes(result, "message 1");
  assertStringIncludes(result, "message 30");
  assertEquals(result.includes("EARLIER CONVERSATION"), false);
});

Deno.test("formatCappedTranscript caps long threads to a summary block plus the last 10 messages", () => {
  const messages = Array.from({ length: 45 }, (_, i) => makeMessage(i + 1));
  const result = formatCappedTranscript(messages, "Customer is waiting on a refund for order 4521.");

  assertStringIncludes(
    result,
    "EARLIER CONVERSATION (summary): Customer is waiting on a refund for order 4521.",
  );
  assertStringIncludes(result, "message 36");
  assertStringIncludes(result, "message 45");
  assertEquals(result.includes("message 35"), false);
});

Deno.test("formatCappedTranscript notes truncation when no summary is available for a long thread", () => {
  const messages = Array.from({ length: 31 }, (_, i) => makeMessage(i + 1));
  const result = formatCappedTranscript(messages, null);

  assertStringIncludes(
    result,
    "EARLIER CONVERSATION (summary): (21 earlier messages not shown; no summary available yet)",
  );
});

Deno.test("formatBriefBlock returns an empty string when the brief has no facts and no summary", () => {
  const brief: ThreadBrief = { summary: null, facts: {}, updated_at: null };
  assertEquals(formatBriefBlock(brief), "");
});

Deno.test("formatBriefBlock renders a facts key/value list when facts are present", () => {
  const brief: ThreadBrief = {
    summary: null,
    facts: { order_number: "4521", refund_offered: "20" },
    updated_at: null,
  };
  const result = formatBriefBlock(brief);
  assertStringIncludes(result, "THREAD BRIEF");
  assertStringIncludes(result, "order_number");
  assertStringIncludes(result, "4521");
  assertStringIncludes(result, "refund_offered");
});

Deno.test("formatBriefBlock appends a Summary line when a summary is present", () => {
  const brief: ThreadBrief = {
    summary: "Customer is chasing a delayed order.",
    facts: {},
    updated_at: "2026-07-19T00:00:00.000Z",
  };
  assertStringIncludes(formatBriefBlock(brief), "Summary: Customer is chasing a delayed order.");
});

Deno.test("formatBriefBlock renders facts and summary together", () => {
  const brief: ThreadBrief = {
    summary: "Customer wants a refund.",
    facts: { order_number: "4521" },
    updated_at: "2026-07-19T00:00:00.000Z",
  };
  const result = formatBriefBlock(brief);
  assertStringIncludes(result, "order_number");
  assertStringIncludes(result, "Summary: Customer wants a refund.");
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
cd api && deno test --allow-net --allow-env --allow-read services/playbook/context-utils_test.ts
```

Expected: fails to run - `error: Module not found "file:///.../api/services/playbook/context-utils.ts"`.

- [ ] **Step 3: Implement `context-utils.ts`**

```ts
/**
 * Shared context-assembly helpers used by AI-facing playbook steps.
 * Centralises variable-presence semantics and transcript capping so every
 * judgment-type step (ask_customer, evaluate, triage, the composer) agrees
 * on what "known" and "recent" mean, instead of each maintaining its own
 * slightly different check.
 */
import type { Message } from "../../types/index.ts";
import { formatTranscript } from "../email-text.ts";
import type { ThreadBrief } from "./brief.ts";

const RECENT_MESSAGE_COUNT = 10;
const FULL_TRANSCRIPT_CAP = 30;

/**
 * Whether a context-bag value counts as "known". Null, undefined, and
 * whitespace-only strings are absent; everything else (including 0 and
 * false) is present. A single definition replaces the two checks that used
 * to disagree (`== null` in ask_customer, `=== null || === undefined || === ""`
 * in evaluate) and silently produced different behaviour for the same var.
 */
export function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

/**
 * Format a thread transcript for an AI prompt, capped so very long threads
 * don't blow the context window or bury the recent conversation. Threads at
 * or under 30 messages get the full transcript, unchanged. Longer threads
 * get the brief summary standing in for everything before the last 10
 * messages, which are shown in full.
 */
export function formatCappedTranscript(messages: Message[], summary: string | null): string {
  if (messages.length <= FULL_TRANSCRIPT_CAP) {
    return formatTranscript(messages);
  }

  const recent = messages.slice(-RECENT_MESSAGE_COUNT);
  const earlierCount = messages.length - recent.length;
  const summaryLine = summary
    ? `EARLIER CONVERSATION (summary): ${summary}`
    : `EARLIER CONVERSATION (summary): (${earlierCount} earlier messages not shown; no summary available yet)`;

  return `${summaryLine}\n\n---\n\n${formatTranscript(recent)}`;
}

/**
 * Render a thread's brief (durable facts plus, once the thread is long
 * enough, a rolling summary) as a THREAD BRIEF prompt section. evaluate and
 * triage only see formatCappedTranscript's transcript, which only carries a
 * summary once a thread crosses 30 messages and never carries extracted
 * facts at all - this closes that gap so both judgment steps see what the
 * thread already knows, the same way the composer's own inline THREAD BRIEF
 * section does for customer-facing replies. Returns "" (nothing to prepend)
 * when the brief has neither facts nor a summary yet.
 */
export function formatBriefBlock(brief: ThreadBrief): string {
  const sections: string[] = [];

  if (Object.keys(brief.facts).length > 0) {
    const factLines = Object.entries(brief.facts)
      .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
      .join("\n");
    sections.push(`Facts:\n${factLines}`);
  }

  if (brief.summary) {
    sections.push(`Summary: ${brief.summary}`);
  }

  if (sections.length === 0) return "";
  return `THREAD BRIEF:\n${sections.join("\n\n")}`;
}
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd api && deno test --allow-net --allow-env --allow-read services/playbook/context-utils_test.ts
```

Expected: `ok | 11 passed | 0 failed` (4 `isPresent` + 3 `formatCappedTranscript` + 4 new `formatBriefBlock` = 11; note this corrects the original step's stated `8 passed`, which undercounted the original 7 `isPresent`/`formatCappedTranscript` tests shown in Step 1 by one).

- [ ] **Step 5: Commit**

```bash
git add api/services/playbook/context-utils.ts api/services/playbook/context-utils_test.ts
git commit -m "Add isPresent and formatCappedTranscript shared helpers"
```

- [ ] **Step 6: Wire `isPresent` into `ask_customer.ts`**

In `api/services/playbook/handlers/ask_customer.ts`, add the import after the existing `resolveReplyAddress` import (line 16):

```ts
import { resolveReplyAddress } from "../../reply-address.ts";
import { isPresent } from "../context-utils.ts";
```

Then replace line 83:

```ts
    const missing = requiredContext.filter((v) => ctx.variables[v] == null);
```

with:

```ts
    const missing = requiredContext.filter((v) => !isPresent(ctx.variables[v]));
```

- [ ] **Step 7: Wire `isPresent` into `evaluate.ts`**

In `api/services/playbook/handlers/evaluate.ts`, add the import after the existing `formatTranscript` import (line 14):

```ts
import { formatTranscript } from "../../email-text.ts";
import { isPresent } from "../context-utils.ts";
```

Then replace lines 24-27:

```ts
    const missing = requiredContext.filter((key) => {
      const val = ctx.variables[key];
      return val === null || val === undefined || val === "";
    });
```

with:

```ts
    const missing = requiredContext.filter((key) => !isPresent(ctx.variables[key]));
```

- [ ] **Step 8: Compile-check and run the full suite**

```bash
cd api && deno check main.ts && deno test --allow-net --allow-env --allow-read
```

Expected: `deno check` produces no output; `deno test` reports `ok | 25 passed | 0 failed` (14 original + 11 from context-utils_test.ts, per the corrected count in Step 4 above).

- [ ] **Step 9: Commit**

```bash
git add api/services/playbook/handlers/ask_customer.ts api/services/playbook/handlers/evaluate.ts
git commit -m "Replace divergent presence checks in ask_customer and evaluate with isPresent"
```

---

### Task 4: Unified composer

**Files:**
- Modify: `api/services/playbook/types.ts:205-232` (widen `RunContext.messages`)
- Modify: `api/services/playbook/executor.ts:38-46,132-136` (drop `RunMessage`, widen the message query)
- Create: `api/services/playbook/composer.ts`
- Test: `api/services/playbook/composer_test.ts`
- Modify: `api/services/playbook/handlers/ask_customer.ts` (imports + lines 98-269, the AI-driven path after Task 3's edit)
- Modify: `api/services/playbook/handlers/send_reply.ts` (imports + lines 25-28, 36-102)
- Modify: `api/services/playbook/handlers/evaluate.ts` (imports + lines 43-64, after Task 3's edit)
- Modify: `api/services/playbook/handlers/triage.ts:7-9,87`
- Modify: `docs/TASK_LOG.md` (new top entry summarizing the AI layer, Tasks 1-4)

**Interfaces:**
- Consumes: `getThreadBrief`, `ensureBriefSummary` from Task 1's `brief.ts`; `isPresent`, `formatCappedTranscript`, `formatBriefBlock` from Task 3's `context-utils.ts`; `chatCompletion`, `getModel` from `api/services/ai.ts`; `AppError` from `api/types/index.ts:280-289`; `RunContext` from `./types.ts`.
- Produces: `AiCall`, `ComposerInputs`, `AskDecision`, `assembleComposerContext`, `buildComposerContext`, `composeAskDecision`, `composeReplyBody` (see PRODUCED INTERFACES above). No later task in this plan consumes these further, but they are the extension seam for later phases (reliability layer, product layer).

**Deviation flags for this task (all stated up front, all explained where they occur):**
1. `RunContext.messages` is widened from a bespoke inline type to the canonical `Message` type. Not explicitly requested, but structurally required: `formatCappedTranscript`/`ensureBriefSummary` are typed to take `Message[]`, and under this repo's `strict: true` compiler options, passing `ctx.messages` (which was missing `thread_id` and `gmail_message_id`) into a `Message[]`-typed parameter would not compile. The two missing columns already exist on the `messages` table and were simply not being selected.
2. `composer.ts` additionally exports `assembleComposerContext` (pure, synchronous) beyond the spec's named exports, for the same reason as `shouldRegenerateSummary` in Task 1: `buildComposerContext` touches Postgres and (via `ensureBriefSummary`) potentially OpenAI, so the "snapshot-style test asserting the assembled prompt contains the full transcript and brief blocks" the spec calls for needs a pure function to snapshot against. `buildComposerContext` becomes a thin wrapper: fetch the brief and summary, then call `assembleComposerContext`.
3. `composeAskDecision`/`composeReplyBody` return `{ decision, aiCall }` / `{ body, aiCall }` rather than bare `decision`/`body`, so `ask_customer.ts`/`send_reply.ts` keep populating `StepResult.aiCalls` from the returned `aiCall`, preserving the `playbook_step_executions.ai_calls` audit trail exactly as today. One narrow gap remains, unchanged by this: a malformed or unparseable AI response still surfaces as a thrown `AppError` rather than a returned value (there is no "parse failed" variant in the locked `AskDecision` type to carry a decision-shaped failure), so that one edge case's `aiCall` is not captured in `ai_calls` - it lands in `playbook_step_executions.error` via `executor.ts`'s generic catch instead, matching how any other thrown structural error in a step handler is recorded today.

- [ ] **Step 1: Widen `RunContext.messages` to `Message[]`**

In `api/services/playbook/types.ts`, add an import at the very top of the file (before the existing doc comment's closing `*/`, i.e. as the first statement after it):

```ts
/**
 * Playbook engine types.
 * Mirrors the data model from docs/PLAYBOOK_ENGINE.md.
 */
import type { Message } from "../../types/index.ts";
```

Then replace lines 212-221:

```ts
  /** All messages on this thread, oldest first */
  messages: Array<{
    id: number;
    from_address: string;
    body_plain: string;
    body_html: string;
    direction: "inbound" | "outbound";
    received_at: Date;
    message_id_header: string | null;
  }>;
```

with:

```ts
  /** All messages on this thread, oldest first */
  messages: Message[];
```

In `api/services/playbook/executor.ts`, remove the now-redundant local interface (lines 38-46):

```ts
interface RunMessage {
  id: number;
  from_address: string;
  body_plain: string;
  body_html: string;
  direction: "inbound" | "outbound";
  received_at: Date;
  message_id_header: string | null;
}
```

Change the import on line 8 to include `Message`:

```ts
import { AppError, Message } from "../../types/index.ts";
```

And widen the message query (lines 132-136):

```ts
  // Load messages
  const messages = await query<RunMessage>(
    "SELECT id, from_address, body_plain, body_html, direction, received_at, message_id_header FROM messages WHERE thread_id = $1 ORDER BY received_at ASC",
    [run.thread_id],
  );
```

to:

```ts
  // Load messages
  const messages = await query<Message>(
    "SELECT id, thread_id, gmail_message_id, from_address, body_plain, body_html, direction, received_at, message_id_header FROM messages WHERE thread_id = $1 ORDER BY received_at ASC",
    [run.thread_id],
  );
```

This is backward compatible with every existing `ctx.messages` call site (`ask_customer.ts`, `send_reply.ts`, `evaluate.ts`, `triage.ts`, `extract.ts`, `find_sheet_row.ts`, `approval-sender.ts` all only read a subset of the now-wider shape).

- [ ] **Step 2: Compile-check**

```bash
cd api && deno check main.ts
```

Expected: no output, exit code 0. If it fails, the error will name the exact call site still relying on the old narrower shape - fix that call site to match, don't loosen the type back down.

Commit this prep step on its own before starting the composer's TDD cycle:

```bash
git add api/services/playbook/types.ts api/services/playbook/executor.ts
git commit -m "Widen RunContext.messages to the canonical Message type"
```

- [ ] **Step 3: Write the failing composer tests**

`api/services/playbook/composer_test.ts`:

```ts
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assembleComposerContext } from "./composer.ts";
import type { ComposerInputs } from "./composer.ts";
import type { ThreadBrief } from "./brief.ts";
import type { Playbook, PlaybookRun, RunContext } from "./types.ts";
import type { Message } from "../../types/index.ts";

function makeMessage(id: number, direction: "inbound" | "outbound" = "inbound"): Message {
  return {
    id,
    thread_id: 1,
    gmail_message_id: `gmail-${id}`,
    from_address: direction === "inbound" ? "customer@example.com" : "support@store.com",
    body_plain: `message body ${id}`,
    body_html: "",
    received_at: new Date(2026, 0, 1, 0, 0, id),
    direction,
    message_id_header: null,
  };
}

function makePlaybook(): Playbook {
  return {
    id: 1,
    workspace_id: 1,
    category_id: 1,
    name: "Test playbook",
    plain_language_description: null,
    steps: [],
    version: 1,
    is_active: true,
    customer_silence_hours: 168,
    writing_style: "friendly and professional",
    reply_mode: "draft_only",
    confidence_threshold: 0.8,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function makeRun(): PlaybookRun {
  return {
    id: 1,
    workspace_id: 1,
    thread_id: 1,
    playbook_id: 1,
    playbook_version: 1,
    steps_snapshot: [],
    current_step_id: "ask_1",
    status: "running",
    context: {},
    retry_count: 0,
    next_retry_at: null,
    send_after: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function makeCtx(messages: Message[], variables: Record<string, unknown> = {}): RunContext {
  return {
    run: makeRun(),
    playbook: makePlaybook(),
    threadId: 1,
    workspaceId: 1,
    variables,
    messages,
    email: "store@example.com",
    gmailThreadId: "gmail-thread-1",
    subject: "Where is my order?",
    senderName: "Kieran",
    storeProfile: "STORE: Exclusive Motors",
  };
}

const emptyBrief: ThreadBrief = { summary: null, facts: {}, updated_at: null };

Deno.test("assembleComposerContext includes the full transcript and sign-off for a short thread", () => {
  const messages = Array.from({ length: 5 }, (_, i) => makeMessage(i + 1));
  const inputs: ComposerInputs = {
    ctx: makeCtx(messages, { order_number: "4521" }),
    goal: "Confirm the order number",
    voice: undefined,
    requiredContext: ["order_number"],
    priorSent: [],
  };

  const result = assembleComposerContext(inputs, emptyBrief, null);

  assertStringIncludes(result, "message body 1");
  assertStringIncludes(result, "message body 5");
  assertStringIncludes(result, "SIGN OFF AS: Kieran");
  assertStringIncludes(result, "STORE CONTEXT");
  assertStringIncludes(result, "THREAD BRIEF");
});

Deno.test("assembleComposerContext caps a long thread's transcript and surfaces the brief summary and facts", () => {
  const messages = Array.from({ length: 40 }, (_, i) => makeMessage(i + 1));
  const brief: ThreadBrief = {
    summary: "Customer is chasing a delayed order and has been offered a partial refund.",
    facts: { order_number: "4521", refund_offered: "20" },
    updated_at: "2026-07-19T00:00:00.000Z",
  };
  const inputs: ComposerInputs = {
    ctx: makeCtx(messages, { order_number: "4521" }),
    goal: "Close out the refund conversation",
    voice: "warm and direct",
    requiredContext: ["order_number", "tracking_number"],
    priorSent: ["Can you confirm your order number?"],
  };

  const result = assembleComposerContext(inputs, brief, brief.summary);

  assertStringIncludes(result, "THREAD BRIEF");
  assertStringIncludes(result, "Customer is chasing a delayed order");
  assertStringIncludes(result, "refund_offered");
  assertStringIncludes(result, "WHAT WE STILL NEED");
  assertStringIncludes(result, "tracking_number");
  assertStringIncludes(result, "message body 31");
  assertStringIncludes(result, "message body 40");
  assertEquals(result.includes("message body 20"), false);
  assertStringIncludes(result, "Can you confirm your order number?");
});

Deno.test("assembleComposerContext filters ctx.variables through isPresent for WHAT WE KNOW", () => {
  const messages = [makeMessage(1)];
  const inputs: ComposerInputs = {
    ctx: makeCtx(messages, { order_number: "4521", customer_name: "", quantity: 0 }),
    goal: "Test presence filtering",
    voice: undefined,
    requiredContext: [],
    priorSent: [],
  };

  const result = assembleComposerContext(inputs, emptyBrief, null);
  const knowSection = result.split("WHAT WE KNOW:")[1].split("WHAT WE STILL NEED:")[0];

  assertStringIncludes(knowSection, "order_number");
  assertStringIncludes(knowSection, "quantity");
  assertEquals(knowSection.includes("customer_name"), false);
});
```

- [ ] **Step 4: Run the tests and verify they fail**

```bash
cd api && deno test --allow-net --allow-env --allow-read services/playbook/composer_test.ts
```

Expected: fails to run - `error: Module not found "file:///.../api/services/playbook/composer.ts"`.

- [ ] **Step 5: Implement `composer.ts`**

```ts
/**
 * Unified reply composer - the single place that assembles prompt context
 * for anything writing a customer-facing message. Replaces the divergent
 * prompt builders that used to live separately in ask_customer.ts and
 * send_reply.ts, which had quietly drifted (different transcript windows,
 * different presence checks) and produced inconsistent reply quality.
 */
import type { RunContext } from "./types.ts";
import { AppError } from "../../types/index.ts";
import { chatCompletion, getModel } from "../ai.ts";
import { ensureBriefSummary, getThreadBrief } from "./brief.ts";
import type { ThreadBrief } from "./brief.ts";
import { formatCappedTranscript, isPresent } from "./context-utils.ts";

export type ComposerInputs = {
  ctx: RunContext;
  goal: string;
  voice: string | undefined;
  requiredContext: string[];
  priorSent: string[];
};

export type AskDecision =
  | { action: "ask"; message: string }
  | { action: "skip"; extracted: Record<string, unknown> }
  | { action: "escalate"; reason: string };

// Reuses the exact element shape StepResult.aiCalls already carries in
// types.ts (`{ model, prompt, response, tokens: undefined }`, used by every
// AI-calling handler today) so ask_customer.ts and send_reply.ts can keep
// populating playbook_step_executions.ai_calls after moving their prompt
// building into this module - the audit trail must not regress.
export type AiCall = { model: string; prompt: string; response: string; tokens?: number };

/**
 * Pure prompt-context assembly, unit-testable without touching Postgres or
 * OpenAI. buildComposerContext (below) is the DB/AI-touching entry point
 * later tasks call; this export exists only so the assembly logic itself
 * gets a real failing-test-first cycle, mirroring the resolveTriageDecision
 * / triageHandler split already used in triage.ts.
 */
export function assembleComposerContext(
  inputs: ComposerInputs,
  brief: ThreadBrief,
  summary: string | null,
): string {
  const { ctx, requiredContext, priorSent } = inputs;
  const sections: string[] = [];

  if (ctx.senderName) {
    sections.push(`SIGN OFF AS: ${ctx.senderName}`);
  }

  if (ctx.storeProfile) {
    sections.push(
      `STORE CONTEXT (use naturally where relevant, do not mention robotically):\n${ctx.storeProfile}`,
    );
  }

  const briefLines: string[] = [];
  if (Object.keys(brief.facts).length > 0) {
    briefLines.push(`Facts:\n${JSON.stringify(brief.facts, null, 2)}`);
  }
  briefLines.push(`Summary: ${summary ?? "(none yet - early in the conversation)"}`);
  sections.push(`THREAD BRIEF:\n${briefLines.join("\n\n")}`);

  const haveContext: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx.variables)) {
    if (isPresent(value)) haveContext[key] = value;
  }
  sections.push(`WHAT WE KNOW:\n${JSON.stringify(haveContext, null, 2)}`);

  const missing = requiredContext.filter((key) => !isPresent(ctx.variables[key]));
  sections.push(
    `WHAT WE STILL NEED:\n${
      missing.length > 0 ? missing.join(", ") : "nothing - all required context is present"
    }`,
  );

  sections.push(`FULL TRANSCRIPT:\n${formatCappedTranscript(ctx.messages, summary)}`);

  sections.push(
    `PREVIOUS MESSAGES WE SENT (do NOT repeat these):\n${
      priorSent.length > 0 ? priorSent.map((m) => `- ${m}`).join("\n") : "none"
    }`,
  );

  return sections.join("\n\n");
}

/**
 * Fetch the thread brief and summary, then assemble the shared prompt
 * context both composeAskDecision and composeReplyBody build their
 * decision-specific system prompt around.
 */
export async function buildComposerContext(inputs: ComposerInputs): Promise<string> {
  const { ctx } = inputs;
  const brief = await getThreadBrief(ctx.threadId);
  const summary = await ensureBriefSummary(ctx.workspaceId, ctx.threadId, ctx.messages);
  return assembleComposerContext(inputs, brief, summary);
}

/**
 * Decide what to do about a customer thread that's missing required
 * context: skip the ask (the answer was already in the conversation),
 * escalate (the thread has gone in circles), or ask (write the next
 * question). Preserves ask_customer's existing decision rules and
 * anti-repetition instructions - only the context assembly moved.
 */
export async function composeAskDecision(
  inputs: ComposerInputs,
): Promise<{ decision: AskDecision; aiCall: AiCall }> {
  const { ctx, goal, voice } = inputs;
  const composerContext = await buildComposerContext(inputs);
  const resolvedVoice = voice ?? (ctx.playbook.writing_style || "friendly and professional");

  const systemPrompt =
    `You are helping a support agent handle an email thread. You write the next message to send to the customer.

TASK: ${goal}

VOICE: ${resolvedVoice}

${composerContext}

YOUR DECISION - return one of:
- {"action": "skip", "extracted": {"var1": "value", ...}, "reasoning": "..."} if the customer's messages already gave us what we need (even if loosely phrased)
- {"action": "escalate", "reason": "..."} if the customer is frustrated, confused, repeating themselves, or this conversation is going in circles
- {"action": "ask", "message": "..."} to write a brief, contextual message that references what the customer said and asks specifically for what's still missing

RULES:
- Do not repeat a question that appears in PREVIOUS MESSAGES WE SENT.
- Acknowledge the customer's most recent message before asking for anything.
- Keep it brief - one short paragraph.
- Match the VOICE.${
      ctx.senderName
        ? `\n- Sign off using the exact name: ${ctx.senderName}`
        : "\n- Do not include a name placeholder."
    }
- NEVER use placeholder text like [Your Name], [Name], or any text in square brackets.
- Output JSON only. No preamble, no markdown.`;

  const model = await getModel(ctx.workspaceId);
  const response = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Decide and respond." },
    ],
    model,
    { type: "json_object" },
  );

  const aiCall: AiCall = { model, prompt: systemPrompt, response, tokens: undefined };

  let parsed: {
    action?: string;
    extracted?: Record<string, unknown>;
    reason?: string;
    message?: string;
  };
  try {
    parsed = JSON.parse(response);
  } catch {
    throw new AppError(502, "composeAskDecision: AI returned invalid JSON", response);
  }

  if (parsed.action === "skip") {
    return { decision: { action: "skip", extracted: parsed.extracted ?? {} }, aiCall };
  }
  if (parsed.action === "escalate") {
    return {
      decision: { action: "escalate", reason: parsed.reason ?? "AI escalated without a reason" },
      aiCall,
    };
  }
  if (parsed.action === "ask" && parsed.message) {
    return { decision: { action: "ask", message: parsed.message }, aiCall };
  }

  throw new AppError(502, `composeAskDecision: AI returned unexpected action: ${parsed.action}`);
}

/**
 * Draft the reply body for a send_reply step. Preserves send_reply's
 * existing voice/sign-off/no-placeholder rules - only the context assembly
 * moved into buildComposerContext.
 */
export async function composeReplyBody(
  inputs: ComposerInputs & { referenceContext: Record<string, unknown> },
): Promise<{ body: string; aiCall: AiCall }> {
  const { ctx, goal, voice, referenceContext } = inputs;
  const composerContext = await buildComposerContext(inputs);
  const resolvedVoice = voice ?? (ctx.playbook.writing_style || "friendly and professional");

  const systemPrompt = `Write a brief reply to this email thread.

GOAL: ${goal}

VOICE: ${resolvedVoice}

MUST REFERENCE NATURALLY (do not list robotically - weave into the message):
${
    Object.keys(referenceContext).length > 0
      ? JSON.stringify(referenceContext, null, 2)
      : "no specific values required"
  }

${composerContext}

RULES:
- Brief. One short paragraph unless the customer asked multiple things.
- Match the VOICE. Don't sound corporate unless the voice says so.
- Reference facts from context naturally (e.g. the amount, order number) - don't list them like a form.
- Don't start with "Thank you for" unless the voice specifically calls for it.${
    ctx.senderName
      ? `\n- Sign off using the exact name: ${ctx.senderName}`
      : "\n- Do not include a sign-off or name placeholder."
  }
- NEVER use placeholder text like [Your Name], [Name], or any text in square brackets.
- Return ONLY the message body. No JSON, no subject line, no surrounding quotes.`;

  const model = await getModel(ctx.workspaceId);
  const response = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Write the reply." },
    ],
    model,
  );

  const body = response.trim();
  const aiCall: AiCall = { model, prompt: systemPrompt, response, tokens: undefined };
  return { body, aiCall };
}
```

- [ ] **Step 6: Run the tests and verify they pass**

```bash
cd api && deno test --allow-net --allow-env --allow-read services/playbook/composer_test.ts
```

Expected: `ok | 3 passed | 0 failed`.

- [ ] **Step 7: Commit**

```bash
git add api/services/playbook/composer.ts api/services/playbook/composer_test.ts
git commit -m "Add unified composer for ask_customer and send_reply prompt assembly"
```

- [ ] **Step 8: Rewire `ask_customer.ts` to call the composer**

Replace the import block (lines 1-16, after Task 3's Step 6 added `isPresent`):

```ts
/**
 * Ask customer handler - AI-driven contextual message to gather missing info.
 * Falls back to literal message for backward compatibility.
 */
import type {
  AskCustomerStep,
  PlaybookStep,
  RunContext,
  StepHandler,
  StepResult,
} from "../types.ts";
import { sendReply } from "../../gmail.ts";
import { query } from "../../../db/client.ts";
import { resolveReplyAddress } from "../../reply-address.ts";
import { composeAskDecision } from "../composer.ts";
```

(This drops `chatCompletion`/`getModel` from `../../ai.ts` and `formatTranscript` from `../../email-text.ts`, both now used inside `composer.ts` instead. `isPresent` stays, still used by the deterministic pre-check below.)

Everything from the top of `execute()` through the deterministic pre-check (the legacy no-goal path, the `lastInbound`/`replyAddress` lookup, and the `missing`/early-return block from Task 3's edit) is unchanged. Replace everything from the `// 2. Resolve writing voice` comment through the end of the file:

```ts
    // 2. Load previous ask_customer messages sent on this run (anti-repetition)
    const prevExecutions = await query<{ output: { message_sent?: string } | null }>(
      `SELECT output FROM playbook_step_executions
       WHERE run_id = $1 AND step_id = $2 AND status = 'success'
       ORDER BY created_at ASC`,
      [ctx.run.id, step.id],
    );
    const previousMessages = prevExecutions
      .map((e) => e.output?.message_sent)
      .filter((m): m is string => !!m);

    // 3. Ask the composer to decide: skip, escalate, or ask. It owns prompt
    // assembly (thread brief, capped transcript, WHAT WE KNOW/STILL NEED) so
    // ask_customer and send_reply stop maintaining their own divergent copies.
    // aiCall is threaded straight into StepResult.aiCalls below so the
    // playbook_step_executions.ai_calls audit trail is unchanged by moving
    // prompt construction into the composer.
    const { decision, aiCall } = await composeAskDecision({
      ctx,
      goal: askStep.goal,
      voice: askStep.voice_hint,
      requiredContext,
      priorSent: previousMessages,
    });
    const aiCalls = [aiCall];

    if (decision.action === "skip") {
      console.log(`[playbook] ask_customer: AI skipped for run ${ctx.run.id}`);
      return {
        decision: { action: "advance" },
        contextUpdates: decision.extracted,
        output: {
          action: "skipped",
          extracted_keys: Object.keys(decision.extracted),
        },
        aiCalls,
      };
    }

    if (decision.action === "escalate") {
      console.log(
        `[playbook] ask_customer: AI escalated - ${decision.reason} for run ${ctx.run.id}`,
      );
      return {
        decision: { action: "fail", error: `ask_customer escalated: ${decision.reason}` },
        output: { action: "escalated", reason: decision.reason },
        aiCalls,
      };
    }

    // decision.action === "ask"
    const requireApproval = askStep.require_approval === true ||
      ctx.playbook.reply_mode === "draft_only";

    if (requireApproval) {
      console.log(`[playbook] ask_customer: reply held for approval for run ${ctx.run.id}`);
      return {
        decision: { action: "pause", status: "waiting_for_human" },
        output: {
          action: "pending_approval",
          pending_send: decision.message,
          on_reply_goto: askStep.on_reply_goto,
          step_type: "ask_customer",
          reply_to: replyAddress.address,
          reply_to_source: replyAddress.source,
        },
        aiCalls,
      };
    }

    await sendReply(
      ctx.email,
      ctx.gmailThreadId,
      ctx.subject,
      replyAddress.address,
      decision.message,
      lastInbound.message_id_header,
      ctx.threadId,
      ctx.workspaceId,
    );
    console.log(`[playbook] ask_customer: AI-drafted message sent for run ${ctx.run.id}`);
    return {
      decision: { action: "pause", status: "waiting_for_customer" },
      output: {
        action: "asked",
        message_sent: decision.message,
        on_reply_goto: askStep.on_reply_goto,
        reply_to: replyAddress.address,
        reply_to_source: replyAddress.source,
      },
      aiCalls,
    };
  },
};
```

No unit test for this rewire (matches existing convention - `ask_customer.ts` has no test file before or after this change; its DB/AI-touching orchestration is verified via `deno check` plus the manual dry-run harness, not a `Deno.test`).

- [ ] **Step 9: Rewire `send_reply.ts` to call the composer**

Replace the import block (lines 1-10):

```ts
/**
 * Send reply handler - sends a reply to the customer and advances.
 * Preferred path: AI-drafted from goal + reference_context.
 * Fallback: literal message string (backward compat).
 */
import type { PlaybookStep, RunContext, SendReplyStep, StepHandler, StepResult } from "../types.ts";
import { sendReply } from "../../gmail.ts";
import { resolveReplyAddress } from "../../reply-address.ts";
import { composeReplyBody } from "../composer.ts";
import { isPresent } from "../context-utils.ts";
```

Keep the `let body`/`let aiCalls` declaration (lines 25-28) as-is - `aiCalls` is still populated below, now from the composer's returned `aiCall` instead of a locally-built prompt/response pair:

```ts
    let body: string;
    let aiCalls:
      | Array<{ model: string; prompt: string; response: string; tokens: undefined }>
      | undefined;
```

Replace the AI-drafted branch (lines 36-102, from `} else if (` through the `} else {` that starts the literal-message-missing error branch):

```ts
    } else if (
      hasGoal ||
      (sendStep.message && typeof sendStep.message === "object" &&
        "ai_generate_using_category_voice" in (sendStep.message as object))
    ) {
      // AI-drafted path - composer owns prompt assembly (thread brief, capped
      // transcript, sign-off/voice rules) so this and ask_customer stop
      // maintaining their own divergent copies of the same context-building.
      // aiCall is kept in aiCalls below so playbook_step_executions.ai_calls
      // is unchanged by moving prompt construction into the composer.
      const goal = sendStep.goal ??
        "Write a helpful and contextual reply to close out this interaction";

      const referenceContext: Record<string, unknown> = {};
      for (const key of (sendStep.reference_context ?? [])) {
        if (isPresent(ctx.variables[key])) referenceContext[key] = ctx.variables[key];
      }

      const composed = await composeReplyBody({
        ctx,
        goal,
        voice: sendStep.voice_hint,
        requiredContext: [],
        priorSent: [],
        referenceContext,
      });
      body = composed.body;
      aiCalls = [composed.aiCall];
    } else {
```

The closing return statement (the last `return` in the file) is unchanged - it already includes `aiCalls`:

```ts
    return {
      decision: { action: "advance" },
      output: {
        message_sent: body,
        reply_to: replyAddress.address,
        reply_to_source: replyAddress.source,
      },
      aiCalls,
    };
```

No unit test for this rewire, for the same reason as Step 8.

- [ ] **Step 10: Switch `evaluate.ts` to `formatCappedTranscript` and prepend the thread brief**

Note: the actual current file (verified by reading `api/services/playbook/handlers/evaluate.ts`
after Task 3's Step 7 landed) still builds its AI-path context from a hardcoded last-3-messages
window under a "RECENT CONVERSATION" heading, not from any transcript-capping helper - the
before/after below is corrected to match that real code (an earlier draft of this step showed a
"before" that already contained the "after" state, which cannot have been the actual starting
point).

Replace the import block:

```ts
import type { EvaluateStep, PlaybookStep, RunContext, StepHandler, StepResult } from "../types.ts";
import { chatCompletion, getModel } from "../../ai.ts";
import { formatTranscript } from "../../email-text.ts";
import { isPresent } from "../context-utils.ts";
```

with:

```ts
import type { EvaluateStep, PlaybookStep, RunContext, StepHandler, StepResult } from "../types.ts";
import { chatCompletion, getModel } from "../../ai.ts";
import { ensureBriefSummary, getThreadBrief } from "../brief.ts";
import { formatBriefBlock, formatCappedTranscript, isPresent } from "../context-utils.ts";
```

(`formatTranscript` from `../../email-text.ts` is no longer used anywhere in this file and is
dropped - its one call site, the hardcoded last-3-messages window below, is replaced.)

Replace the AI-path setup and the FULL CONTEXT/RECENT CONVERSATION section of the prompt:

```ts
    // ── AI path: something is missing ──────────────────────────────────────
    // Show the AI the FULL context bag so it can spot info that the extract
    // step may have missed (e.g. the customer quoted their order number in a
    // free-text reply that wasn't formally extracted).
    // No GOAL string - the AI's job is variable presence/validity, not intent.
    const recentMessages = ctx.messages.slice(-3);
    const recentMessagesText = formatTranscript(recentMessages);

    const model = await getModel(ctx.workspaceId);

    const systemPrompt =
      `You are checking whether a customer support workflow has everything it needs to proceed to the next step.
${ctx.storeProfile ? `\nStore context:\n${ctx.storeProfile}\n` : ""}
REQUIRED VARIABLES (all must be present and valid for the workflow to continue):
${requiredContext.map((key) => `- ${key}: ${ctx.variables[key] ?? "(MISSING)"}`).join("\n")}

FULL CONTEXT (everything we know so far):
${JSON.stringify(ctx.variables, null, 2)}

RECENT CONVERSATION (last 3 messages):
${recentMessagesText}

YOUR TASK:
```

with:

```ts
    // ── AI path: something is missing ──────────────────────────────────────
    // Show the AI the FULL context bag so it can spot info that the extract
    // step may have missed (e.g. the customer quoted their order number in a
    // free-text reply that wasn't formally extracted). Uses the same capped
    // transcript and thread-brief block the composer builds for customer-
    // facing replies, instead of a hardcoded last-3-messages window, so a
    // long thread's earlier facts and summary are visible here too.
    // No GOAL string - the AI's job is variable presence/validity, not intent.
    const brief = await getThreadBrief(ctx.threadId);
    const summary = await ensureBriefSummary(ctx.workspaceId, ctx.threadId, ctx.messages);
    const transcriptText = formatCappedTranscript(ctx.messages, summary);
    const briefBlock = formatBriefBlock(brief);

    const model = await getModel(ctx.workspaceId);

    const systemPrompt =
      `You are checking whether a customer support workflow has everything it needs to proceed to the next step.
${ctx.storeProfile ? `\nStore context:\n${ctx.storeProfile}\n` : ""}
REQUIRED VARIABLES (all must be present and valid for the workflow to continue):
${requiredContext.map((key) => `- ${key}: ${ctx.variables[key] ?? "(MISSING)"}`).join("\n")}

FULL CONTEXT (everything we know so far):
${JSON.stringify(ctx.variables, null, 2)}
${briefBlock ? `\n${briefBlock}\n` : ""}
THREAD TRANSCRIPT:
${transcriptText}

YOUR TASK:
```

(the rest of the template literal, from the `YOUR TASK:` line's own content onward, is unchanged).

- [ ] **Step 11: Switch `triage.ts` to `formatCappedTranscript` and prepend the thread brief**

Replace the import block:

```ts
import type { PlaybookStep, RunContext, StepHandler, StepResult, TriageStep } from "../types.ts";
import { chatCompletion, getModel } from "../../ai.ts";
import { formatTranscript } from "../../email-text.ts";
```

with:

```ts
import type { PlaybookStep, RunContext, StepHandler, StepResult, TriageStep } from "../types.ts";
import { chatCompletion, getModel } from "../../ai.ts";
import { ensureBriefSummary, getThreadBrief } from "../brief.ts";
import { formatBriefBlock, formatCappedTranscript } from "../context-utils.ts";
```

(`formatTranscript` from `../../email-text.ts` is no longer used anywhere in this file and is
dropped, same as `evaluate.ts` in Step 10.)

Replace line 87 (`const transcript = formatTranscript(ctx.messages);`):

```ts
    const transcript = formatTranscript(ctx.messages);
```

with:

```ts
    const brief = await getThreadBrief(ctx.threadId);
    const summary = await ensureBriefSummary(ctx.workspaceId, ctx.threadId, ctx.messages);
    const transcript = formatCappedTranscript(ctx.messages, summary);
    const briefBlock = formatBriefBlock(brief);
```

Then, in the same file's `systemPrompt` template literal, replace the FULL WORKFLOW CONTEXT /
THREAD TRANSCRIPT section:

```ts
FULL WORKFLOW CONTEXT:
${JSON.stringify(ctx.variables, null, 2)}

THREAD TRANSCRIPT:
${transcript}
```

with:

```ts
FULL WORKFLOW CONTEXT:
${JSON.stringify(ctx.variables, null, 2)}
${briefBlock ? `\n${briefBlock}\n` : ""}
THREAD TRANSCRIPT:
${transcript}
```

- [ ] **Step 12: Compile-check and run the full suite**

```bash
cd api && deno check main.ts && deno test --allow-net --allow-env --allow-read
```

Expected: `deno check` produces no output; `deno test` reports `ok | 28 passed | 0 failed` (25 from the end of Task 3, per the corrected count above, + 3 new composer tests).

- [ ] **Step 13: Lint**

```bash
cd api && deno lint
```

Expected: no output, or only pre-existing warnings unrelated to the files touched in this task. Fix anything new before proceeding.

- [ ] **Step 14: Manual verification against the dry-run harness**

Per `docs/superpowers/specs/2026-07-20-email-autopilot-rethink-design.md` section 6, the repo has a dry-run harness for playbook steps (`api/services/playbook/dry-run.ts`). Run it against a real or synthetic long thread (>30 messages) with an `ask_customer` and a `send_reply` step, and confirm in the output/logs that:
- The composed prompt for both steps contains a `THREAD BRIEF` block and an `EARLIER CONVERSATION (summary):` line rather than the full 30+ message transcript.
- `evaluate` and `triage` steps on the same thread show the same capped-transcript behavior in their prompts, and also carry their own `THREAD BRIEF:` section (from `formatBriefBlock`, Step 10/11 above) even on threads short enough that `formatCappedTranscript` has not started summarising yet.

This is a manual/exploratory check (the harness itself is not part of this plan's file list), not a `Deno.test` - the observation gets folded into the TASK_LOG entry in Step 16 below, not recorded separately.

- [ ] **Step 15: Commit**

```bash
git add api/services/playbook/handlers/ask_customer.ts api/services/playbook/handlers/send_reply.ts api/services/playbook/handlers/evaluate.ts api/services/playbook/handlers/triage.ts
git commit -m "Rewire ask_customer, send_reply, evaluate, and triage onto the unified composer"
```

- [ ] **Step 16: Add the AI layer's top entry to `docs/TASK_LOG.md`**

Insert this entry immediately after the `---` separator that follows the "Format" section, above
the current top entry (write this verbatim; if a later task's entry has already been inserted
there first, insert this one directly above that entry instead, keeping newest-first order):

```markdown
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
  replies.
- `api/services/playbook/types.ts` / `executor.ts`: widened `RunContext.messages` to the
  canonical `Message` type.

**Validation:**
- `deno test --allow-net --allow-env --allow-read` in `api/`: `ok | 28 passed | 0 failed`
  (brief_test.ts, context-utils_test.ts, composer_test.ts, plus the pre-existing 14).
- `deno check main.ts` passes.
- `deno lint` clean on the files touched in this phase.
- Dry-run harness (Step 14 above): confirmed the composed prompt for `ask_customer`/`send_reply`
  on a >30-message thread shows a THREAD BRIEF block and an `EARLIER CONVERSATION (summary):`
  line instead of the full transcript, and that `evaluate`/`triage` show the same capped
  transcript plus their own THREAD BRIEF section.
```

- [ ] **Step 17: Commit the TASK_LOG entry**

```bash
git add docs/TASK_LOG.md
git commit -m "Record the AI layer in TASK_LOG"
```

**Verification gate (ops, owned by Fabien, not an automated step):** Before declaring the AI
layer done, once prod DB read access is available, sample roughly 20 real threads from
production, including failed/stuck runs and threads where an AI reply was actually sent, and
confirm the failures trace back to the four defect clusters this phase targeted (context-starved
prompts, divergent presence checks, no durable thread memory, uncapped transcripts). Keep the
sampled threads and their before/after replies as a reply-quality benchmark for comparing against
once this phase is live. This is a manual review gate blocked on prod access, not something any
task in this plan can complete on its own.

---

# Implementation Plan: Phase 2 (Tasks 5-8) - Reliability Layer

Spec: `docs/superpowers/specs/2026-07-20-email-autopilot-rethink-design.md`, sections 3.2 and 5.
Repo: Deno + Hono API, Postgres 16. Test command verified from `api/deno.json`:

```
deno test --allow-net --allow-env --allow-read
```

Run from the `api/` directory (or `deno task test`, same thing - `deno.json` defines it as a task).

## Testing approach (read this before the tasks)

This repo has zero DB-integration tests today - the four existing `*_test.ts` files
(`triage_test.ts`, `email-text_test.ts`, `google-auth_test.ts`, `reply-address_test.ts`) all
test pure functions extracted from I/O shells, matching the pattern in `triage.ts` /
`triage_test.ts` (`resolveTriageDecision` is exported and unit-tested with no DB, no AI call).

Every task below follows that exact convention: wherever a decision or data transform can be
pulled out of a DB/AI/Gmail-calling function into a small pure exported function, it is, and
that pure function gets the TDD red/green treatment with zero setup. Where the reliability
layer genuinely needs to prove a DB state transition happened (a run's status changed, a
context key was written, a thread flipped to `in_review`), the plan uses real integration
tests against Postgres - there is no mocking layer in this codebase and building one is out of
scope for a reliability fix. Those tests require `DATABASE_URL` set to a real, migrated
database (the same one `docker-compose up -d postgres` gives you locally) and are marked
**[DB]** in the step list. Route-level tests additionally need `API_SECRET` set, because
`api/middleware/auth.ts` reads it at module load time and rejects every request with a 500 if
it's empty - marked **[DB+AUTH]**.

Exact command for DB-backed tests (adjust host/port/creds to your local Postgres):

```
DATABASE_URL=postgres://emaildash:changeme@localhost:5432/emaildash \
API_SECRET=test-secret \
deno test --allow-net --allow-env --allow-read
```

One thing this plan deliberately does NOT do: integration-test `gmail.ts`'s `ingestMessage`
end to end. It calls `fetchGmailThread` -> `getGoogleAccessToken` -> a real Google OAuth
refresh + a real Gmail API fetch, with no seam to fake either. Task 6 tests the pure routing
decision (`resolveInboundRunAction`) exhaustively instead, and the wiring itself is verified
manually (exact `curl` + postgres queries given in that task) - this matches the repo's own
stated verification bar ("check postgres after writes... don't claim done without evidence"),
just not as an automated test.

## PRODUCED INTERFACES

New handler decision (added to `StepDecision` in `api/services/playbook/types.ts`):

```ts
| { action: "escalate"; reason: string }
```

Executor helpers (exported from `api/services/playbook/executor.ts`, consumed by routes and
workers so every escalation/failure looks the same everywhere):

```ts
export async function finalizeEscalation(
  runId: number,
  threadId: number,
  workspaceId: number,
  variables: Record<string, unknown>,
  currentStepId: string | null,
  reason: string,
): Promise<RunResult>

export interface RunSetup {
  playbook: Playbook;
  steps: PlaybookStep[];
  thread: { id: number; gmail_thread_id: string; subject: string; workspace_id: number };
  messages: Message[]; // api/types/index.ts - Phase 1 widens RunContext.messages to this
  tokenRow: { email: string };
  senderName: string | null;
  storeProfile: string | null;
}

export async function loadRunSetup(run: PlaybookRun): Promise<RunSetup>

export function buildRunContext(
  run: PlaybookRun,
  setup: RunSetup,
  variables: Record<string, unknown>,
  currentStepId: string | null,
  status: RunStatus,
): RunContext
```

There is no bespoke `RunMessage` type in this plan. `Message` from `api/types/index.ts`
(`id, thread_id, gmail_message_id, from_address, body_plain, body_html, received_at, direction,
message_id_header`) already carries every field this plan needs - nothing missing, nothing to
re-add.

Composer contract consumed by Task 8 (Phase 1's `api/services/playbook/composer.ts`, final
signatures, `AiCall` matching the exact shape handlers already push into `StepResult.aiCalls`):

```ts
export interface AiCall { model: string; prompt: string; response: string; tokens?: number }
export function composeAskDecision(inputs: ComposerInputs): Promise<{ decision: AskDecision; aiCall: AiCall }>
export function composeReplyBody(
  inputs: ComposerInputs & { referenceContext: Record<string, unknown> },
): Promise<{ body: string; aiCall: AiCall }>
```

Inbound-during-run routing (exported from `api/services/gmail.ts`):

```ts
export type InboundRunAction =
  | "resume" | "attach_to_waiting_human" | "requeue_send" | "store_only" | "none";

export function resolveInboundRunAction(runStatus: RunStatus | null): InboundRunAction

export function appendMessageToWaitingRun(
  context: Record<string, unknown>,
  entry: { message_id: number | null; received_at: string },
): Record<string, unknown>
```

Run context key (JSONB, no migration - lives in the existing `playbook_runs.context` column,
so it is already exposed by every existing run payload: `GET /playbooks/runs`,
`GET /playbooks/runs/:id`, and the `run_updated` SSE event, all of which serialize the full
`context` object today):

```ts
// run.context._messages_since_draft
Array<{ message_id: number | null; received_at: string }>
```

New alert event (added to `AlertEvent` in `api/services/alerts.ts`):

```ts
| "run_failed"
```

New route + service (Task 8):

```ts
POST /playbooks/runs/:runId/regenerate-draft -> { body: string }  // external contract, unchanged
// api/services/playbook/regenerate.ts
export async function regeneratePendingDraft(runId: number): Promise<{ body: string }>
export async function applyRegeneratedDraft(
  runId: number, threadId: number, workspaceId: number, body: string, aiCall: AiCall,
): Promise<void>
```

Test fixtures (Task 5, reused by every later task - `api/services/playbook/test-helpers.ts`,
not itself a test file so `deno test` will not try to run it):

```ts
export interface TestFixture { workspaceId: number; categoryId: number; threadId: number; playbookId: number; }
export async function createTestFixture(steps: PlaybookStep[], options?: { withOAuthToken?: boolean }): Promise<TestFixture>
export async function createTestRun(fixture: TestFixture, steps: PlaybookStep[], currentStepId: string | null, status: RunStatus, context?: Record<string, unknown>): Promise<number>
export async function cleanupFixture(workspaceId: number): Promise<void>
```

## Design decisions worth flagging up front

1. **No new migration.** The spec's section 4 data-model list (next: 028) covers only
   `threads.brief` and the ramp fields - both Phase 1's. It explicitly says "No changes to
   `playbook_runs` statuses." Reading that literally: the escalation reason is NOT a new
   column. It is written into the existing `context` JSONB as `_escalation_reason`, exactly
   the way `_rejection_source` and `_cancelled_reason` already work in this codebase. This
   avoids a migration-number collision with whatever Phase 1 claims as 028.
2. **`evaluate.ts`'s AI escalate path stops using `if_escalate_goto`.** Today it routes to a
   step (usually an `escalate` step with a hardcoded reason string - the exact bug CLAUDE.md's
   known-issues list calls out). After this change it returns the `escalate` decision directly
   with the AI's real reason, terminating the run right there. The `if_escalate_goto` field
   stays on the type for backward compatibility with stored playbooks that reference it, but it
   is no longer read by the evaluate handler.
3. **One shared terminal-state function.** `finalizeEscalation` is the only code path that ever
   writes `status = 'escalated'`. Loop detection, the 50-step cap, the new `escalate` decision,
   the timeout worker, the retry worker's exhausted-retries path, and both human-reject flows
   in `routes/playbooks.ts` all call it. That is what "the two reject flows converge... land in
   escalated via the same code path" means literally here.

---

### Task 5: Escalate decision type and status convergence

**Files:**
- Modify: `api/services/playbook/types.ts` (StepDecision union, `~line 234-243`; doc comment on `EvaluateStep.if_escalate_goto`, `~line 61`)
- Modify: `api/services/playbook/executor.ts` (full file already read; `escalateRunDueToLoop` `~line 70-100`, `advanceRun` switch `~line 391-497`, post-loop block `~line 531-544`)
- Modify: `api/services/playbook/handlers/escalate.ts` (full file, 25 lines)
- Modify: `api/services/playbook/handlers/ask_customer.ts` (`~line 209-216`)
- Modify: `api/services/playbook/handlers/evaluate.ts` (`~line 124-133`)
- Modify: `api/services/playbook/timeout_worker.ts` (full file, 76 lines)
- Modify: `api/services/playbook/retry_worker.ts` (`processRetryRuns`, `~line 36-71`)
- Modify: `api/routes/playbooks.ts` (`/runs/:runId/reject`, `~line 454-479`)
- Create: `api/services/playbook/test-helpers.ts`
- Create: `api/services/playbook/handlers/escalate_test.ts`
- Create: `api/services/playbook/handlers/ask_customer_test.ts`
- Create: `api/services/playbook/handlers/evaluate_test.ts`
- Create: `api/services/playbook/executor_test.ts`
- Create: `api/routes/playbooks_test.ts`

**Interfaces:**
- Consumes: nothing new (uses existing `db/client.ts`, `event-bus.ts`, `alerts.ts`, `db/queries.ts`)
- Produces: `StepDecision` gains `{action:"escalate"; reason:string}`; `executor.ts` exports `finalizeEscalation`; `test-helpers.ts` exports the fixture builders listed in PRODUCED INTERFACES above.

#### Step 1: Add the escalate decision to the shared type

This is a pure type addition - there is no runtime behavior to red/green here, TypeScript's
compiler is the check, and every step after this one will fail to compile until it's done. Not
skipping TDD by choice; noting it because the instructions ask to say so out loud when a step
genuinely has no test of its own.

- [ ] Open `api/services/playbook/types.ts`. Find the `StepDecision` union (currently ends
      `| { action: "fail"; error: string; retriable?: boolean };`). Add a member:
      ```ts
      export type StepDecision =
        | { action: "advance" }
        | { action: "advance_to"; stepId: string }
        | {
          action: "pause";
          status: "waiting_for_customer" | "waiting_for_human" | "waiting_to_send";
          delaySec?: number;
        }
        | { action: "complete" }
        | { action: "escalate"; reason: string }
        | { action: "fail"; error: string; retriable?: boolean };
      ```
- [ ] In the same file, find `EvaluateStep.if_escalate_goto` and add a doc comment noting it is
      vestigial for AI-driven escalation (kept for stored playbooks that still reference it):
      ```ts
        /** Step to jump to when AI detects something wrong even with info present.
         *  @deprecated no longer read by the evaluate handler's AI escalate path, which now
         *  returns an `escalate` decision directly with the AI's real reason. Kept so already-
         *  parsed playbooks with this field configured don't lose data. */
        if_escalate_goto: string;
      ```
- [ ] Run `cd api && deno check services/playbook/types.ts` - expect it to pass (this is a
      structurally valid addition to a union, nothing consumes the new member yet).
- [ ] `git add api/services/playbook/types.ts && git commit -m "Add escalate decision type to playbook step handler result"`

#### Step 2: Fixture helpers for the reliability-layer integration tests

No test for this step either - it is test infrastructure, not behavior. The next step's tests
are what actually exercise it.

- [ ] Create `api/services/playbook/test-helpers.ts`:
      ```ts
      /**
       * Shared fixture builders for playbook reliability-layer integration tests.
       * These run against a real Postgres database - there is no mocking layer in
       * this codebase, and every test using these fixtures needs DATABASE_URL set.
       * workspace_id cascade-deletes everything else via existing FK ON DELETE CASCADE,
       * so cleanupFixture only has to delete the workspace row.
       */
      import { execute, queryOne } from "../../db/client.ts";
      import type { PlaybookStep, RunStatus } from "./types.ts";

      let counter = 0;
      function uniqueSuffix(): string {
        counter++;
        return `${Date.now()}_${counter}`;
      }

      export interface TestFixture {
        workspaceId: number;
        categoryId: number;
        threadId: number;
        playbookId: number;
      }

      export interface TestFixtureOptions {
        /** Set false to simulate a workspace with no connected Gmail account. */
        withOAuthToken?: boolean;
      }

      export async function createTestFixture(
        steps: PlaybookStep[],
        options: TestFixtureOptions = {},
      ): Promise<TestFixture> {
        const withOAuthToken = options.withOAuthToken ?? true;
        const suffix = uniqueSuffix();

        const workspace = await queryOne<{ id: number }>(
          "INSERT INTO workspaces (name) VALUES ($1) RETURNING id",
          [`test-workspace-${suffix}`],
        );
        const workspaceId = workspace!.id;

        const category = await queryOne<{ id: number }>(
          `INSERT INTO categories (workspace_id, name, description, instructions)
           VALUES ($1, $2, '', '') RETURNING id`,
          [workspaceId, `test-category-${suffix}`],
        );
        const categoryId = category!.id;

        const playbook = await queryOne<{ id: number }>(
          `INSERT INTO playbooks (workspace_id, category_id, name, steps, version, is_active, reply_mode)
           VALUES ($1, $2, $3, $4::jsonb, 1, true, 'draft_only') RETURNING id`,
          [workspaceId, categoryId, `test-playbook-${suffix}`, JSON.stringify(steps)],
        );
        const playbookId = playbook!.id;

        const thread = await queryOne<{ id: number }>(
          `INSERT INTO threads (workspace_id, gmail_thread_id, subject, category_id)
           VALUES ($1, $2, 'Test thread', $3) RETURNING id`,
          [workspaceId, `test-thread-${suffix}`, categoryId],
        );
        const threadId = thread!.id;

        if (withOAuthToken) {
          await execute(
            `INSERT INTO oauth_tokens (workspace_id, email, access_token, refresh_token, expiry)
             VALUES ($1, $2, 'test-access-token', 'test-refresh-token', NOW() + interval '1 hour')`,
            [workspaceId, `store-${suffix}@example.com`],
          );
        }

        return { workspaceId, categoryId, threadId, playbookId };
      }

      export async function createTestRun(
        fixture: TestFixture,
        steps: PlaybookStep[],
        currentStepId: string | null,
        status: RunStatus,
        context: Record<string, unknown> = {},
      ): Promise<number> {
        const run = await queryOne<{ id: number }>(
          `INSERT INTO playbook_runs
             (workspace_id, thread_id, playbook_id, playbook_version, steps_snapshot, current_step_id, status, context)
           VALUES ($1, $2, $3, 1, $4::jsonb, $5, $6, $7::jsonb)
           RETURNING id`,
          [
            fixture.workspaceId,
            fixture.threadId,
            fixture.playbookId,
            JSON.stringify(steps),
            currentStepId,
            status,
            JSON.stringify(context),
          ],
        );
        return run!.id;
      }

      export async function cleanupFixture(workspaceId: number): Promise<void> {
        await execute("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      }
      ```
- [ ] Run `cd api && deno check services/playbook/test-helpers.ts` - expect it to pass.
- [ ] `git add api/services/playbook/test-helpers.ts && git commit -m "Add DB fixture helpers for playbook reliability integration tests"`

#### Step 3: escalate.ts handler - reason precedence, new decision (TDD)

- [ ] Write the failing test. Create `api/services/playbook/handlers/escalate_test.ts`:
      ```ts
      import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
      import type { EscalateStep, RunContext } from "../types.ts";
      import { escalateHandler } from "./escalate.ts";

      const escalateStep: EscalateStep = {
        id: "escalate_1",
        type: "escalate",
        reason: "Could not find order in sheet",
      };

      function buildCtx(variables: Record<string, unknown>): RunContext {
        return {
          run: {
            id: 1,
            workspace_id: 1,
            thread_id: 1,
            playbook_id: 1,
            playbook_version: 1,
            current_step_id: "escalate_1",
            status: "running",
            context: variables,
            retry_count: 0,
            next_retry_at: null,
            send_after: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
          playbook: {
            id: 1,
            workspace_id: 1,
            category_id: 1,
            name: "Test playbook",
            plain_language_description: null,
            steps: [escalateStep],
            version: 1,
            is_active: true,
            customer_silence_hours: 168,
            writing_style: "",
            reply_mode: "draft_only",
            confidence_threshold: 0.8,
            created_at: new Date(),
            updated_at: new Date(),
          },
          threadId: 1,
          workspaceId: 1,
          variables,
          messages: [],
          email: "store@example.com",
          gmailThreadId: "gmail-thread-1",
          subject: "Test",
          senderName: null,
          storeProfile: null,
        };
      }

      Deno.test("escalateHandler uses _rejection_source over everything else when set", async () => {
        const ctx = buildCtx({ _rejection_source: "approval_1 (Process refund in Stripe)" });
        const result = await escalateHandler.execute(escalateStep, ctx);
        assertEquals(result.decision, {
          action: "escalate",
          reason: "Rejected by human: approval_1 (Process refund in Stripe)",
        });
      });

      Deno.test("escalateHandler uses a dynamic context reason when _rejection_source is absent", async () => {
        const ctx = buildCtx({ _escalation_reason: "find_sheet_row could not match order 1234" });
        const result = await escalateHandler.execute(escalateStep, ctx);
        assertEquals(result.decision, {
          action: "escalate",
          reason: "find_sheet_row could not match order 1234",
        });
      });

      Deno.test("escalateHandler falls back to the step's static config reason when context has neither", async () => {
        const ctx = buildCtx({});
        const result = await escalateHandler.execute(escalateStep, ctx);
        assertEquals(result.decision, {
          action: "escalate",
          reason: "Could not find order in sheet",
        });
      });
      ```
- [ ] Run `cd api && deno test --allow-net --allow-env --allow-read services/playbook/handlers/escalate_test.ts`
      Expect failure: all three assertions fail because `escalateHandler` still returns
      `{action: "fail", error: ...}`, not `{action: "escalate", reason: ...}`.
- [ ] Implement. Replace `api/services/playbook/handlers/escalate.ts` in full:
      ```ts
      /**
       * Escalate handler - terminates the run in status 'escalated' with the real
       * cause recorded. Reason precedence: an explicit human rejection always wins
       * (_rejection_source, set by the reject route), then a dynamic reason some
       * upstream step already computed and stashed in context (_escalation_reason),
       * then the step's own static config reason as the last resort. This is what
       * stops "Could not find order in sheet" showing up when the real cause was
       * something else entirely - the step's static string is now the fallback,
       * not the only option.
       */
      import type { EscalateStep, PlaybookStep, RunContext, StepHandler, StepResult } from "../types.ts";

      export const escalateHandler: StepHandler = {
        async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
          const escalateStep = step as EscalateStep;

          const rejectionSource = ctx.variables._rejection_source as string | undefined;
          const dynamicReason = ctx.variables._escalation_reason as string | undefined;
          const reason = rejectionSource
            ? `Rejected by human: ${rejectionSource}`
            : dynamicReason ?? escalateStep.reason;

          console.log(`[playbook] escalate: run ${ctx.run.id} - ${reason}`);
          return {
            decision: { action: "escalate", reason },
            output: { reason },
          };
        },
      };
      ```
- [ ] Run `cd api && deno test --allow-net --allow-env --allow-read services/playbook/handlers/escalate_test.ts`
      Expect: `ok | 3 passed | 0 failed`.
- [ ] `git add api/services/playbook/handlers/escalate.ts api/services/playbook/handlers/escalate_test.ts && git commit -m "Return escalate decision from escalate step handler with reason precedence"`

#### Step 4: ask_customer.ts AI escalate path (TDD)

The AI call happens before this branch runs, so the branch itself - "given a parsed escalate
response, produce the reason text" - is extracted as a pure function and tested without
touching `chatCompletion` or the network, same as `resolveTriageDecision` in `triage.ts`.

- [ ] Write the failing test. Create `api/services/playbook/handlers/ask_customer_test.ts`:
      ```ts
      import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
      import { resolveAskCustomerEscalateReason } from "./ask_customer.ts";

      Deno.test("resolveAskCustomerEscalateReason uses the AI's stated reason", () => {
        assertEquals(
          resolveAskCustomerEscalateReason("Customer is repeating themselves and getting frustrated"),
          "Customer is repeating themselves and getting frustrated",
        );
      });

      Deno.test("resolveAskCustomerEscalateReason falls back when the AI gave no reason", () => {
        assertEquals(
          resolveAskCustomerEscalateReason(undefined),
          "ask_customer AI escalated without a stated reason",
        );
      });

      Deno.test("resolveAskCustomerEscalateReason falls back on a blank reason", () => {
        assertEquals(
          resolveAskCustomerEscalateReason("   "),
          "ask_customer AI escalated without a stated reason",
        );
      });
      ```
- [ ] Run `cd api && deno test --allow-net --allow-env --allow-read services/playbook/handlers/ask_customer_test.ts`
      Expect failure: `resolveAskCustomerEscalateReason` does not exist yet (import error / TS2305).
- [ ] Implement. In `api/services/playbook/handlers/ask_customer.ts`, add the exported helper
      near the top (after the imports, before `askCustomerHandler`):
      ```ts
      /**
       * Maps the AI's raw escalate reason to the text that becomes the run's
       * escalation_reason. Extracted as a pure function so it is unit-testable
       * without the chatCompletion call that produces `parsed` in the first place.
       */
      export function resolveAskCustomerEscalateReason(reason: string | undefined): string {
        return reason && reason.trim()
          ? reason
          : "ask_customer AI escalated without a stated reason";
      }
      ```
      Then replace the existing escalate branch (`if (parsed.action === "escalate") { ... }`,
      currently returning `{action: "fail", error: ...}`) with:
      ```ts
      if (parsed.action === "escalate") {
        const reason = resolveAskCustomerEscalateReason(parsed.reason);
        console.log(`[playbook] ask_customer: AI escalated - ${reason} for run ${ctx.run.id}`);
        return {
          decision: { action: "escalate", reason },
          output: { action: "escalated", reason },
          aiCalls,
        };
      }
      ```
- [ ] Run `cd api && deno test --allow-net --allow-env --allow-read services/playbook/handlers/ask_customer_test.ts`
      Expect: `ok | 3 passed | 0 failed`.
- [ ] `git add api/services/playbook/handlers/ask_customer.ts api/services/playbook/handlers/ask_customer_test.ts && git commit -m "Return escalate decision from ask_customer AI escalate path"`

#### Step 5: evaluate.ts AI escalate path - bypass if_escalate_goto (TDD)

- [ ] Write the failing test. Create `api/services/playbook/handlers/evaluate_test.ts`:
      ```ts
      import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
      import { resolveEvaluateEscalateReason } from "./evaluate.ts";

      Deno.test("resolveEvaluateEscalateReason uses the AI's stated reason", () => {
        assertEquals(
          resolveEvaluateEscalateReason("order_number looks like a placeholder, not a real value"),
          "order_number looks like a placeholder, not a real value",
        );
      });

      Deno.test("resolveEvaluateEscalateReason falls back when the AI gave no reason", () => {
        assertEquals(
          resolveEvaluateEscalateReason(undefined),
          "evaluate AI escalated without a stated reason",
        );
      });
      ```
- [ ] Run `cd api && deno test --allow-net --allow-env --allow-read services/playbook/handlers/evaluate_test.ts`
      Expect failure: `resolveEvaluateEscalateReason` does not exist yet.
- [ ] Implement. In `api/services/playbook/handlers/evaluate.ts`, add after the imports:
      ```ts
      /**
       * Maps the AI's raw escalate reason to the run's escalation_reason. Pure,
       * same reasoning as ask_customer's version - unit-testable without the
       * chatCompletion call.
       */
      export function resolveEvaluateEscalateReason(reason: string | undefined): string {
        return reason && reason.trim() ? reason : "evaluate AI escalated without a stated reason";
      }
      ```
      Replace the existing escalate branch:
      ```ts
      if (parsed.action === "escalate") {
      ```
      ...through its closing brace (currently `decision: { action: "advance_to", stepId: evalStep.if_escalate_goto }`)
      with:
      ```ts
      if (parsed.action === "escalate") {
        // Terminate directly with the AI's real reason instead of routing to
        // if_escalate_goto - that field pointed at a step with a hardcoded reason
        // string that didn't reflect what actually went wrong (see CLAUDE.md
        // known issues). The field stays on the type for old playbooks; this
        // handler just stops reading it.
        const reason = resolveEvaluateEscalateReason(parsed.reason);
        console.log(`[playbook] evaluate: AI escalated - ${reason} for run ${ctx.run.id}`);
        return {
          decision: { action: "escalate", reason },
          output: { action: "escalated", reason },
          aiCalls,
        };
      }
      ```
- [ ] Run `cd api && deno test --allow-net --allow-env --allow-read services/playbook/handlers/evaluate_test.ts`
      Expect: `ok | 2 passed | 0 failed`.
- [ ] `git add api/services/playbook/handlers/evaluate.ts api/services/playbook/handlers/evaluate_test.ts && git commit -m "Return escalate decision from evaluate AI escalate path, bypassing if_escalate_goto"`

#### Step 6: executor.ts - finalizeEscalation, the escalate decision case, post-loop cleanup (TDD) [DB]

- [ ] Write the failing test. Create `api/services/playbook/executor_test.ts`:
      ```ts
      import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
      import { queryOne } from "../../db/client.ts";
      import type { EscalateStep } from "./types.ts";
      import { startRun } from "./executor.ts";
      import { cleanupFixture, createTestFixture } from "./test-helpers.ts";

      Deno.test("advanceRun maps an escalate decision to status escalated with the real reason", async () => {
        const steps: EscalateStep[] = [
          { id: "escalate_1", type: "escalate", reason: "Could not find order in sheet" },
        ];
        const fixture = await createTestFixture(steps);
        try {
          const result = await startRun(fixture.workspaceId, fixture.threadId, fixture.playbookId);
          assertEquals(result.status, "escalated");
          assertEquals(result.context._escalation_reason, "Could not find order in sheet");

          const run = await queryOne<{ status: string; context: Record<string, unknown> }>(
            "SELECT status, context FROM playbook_runs WHERE id = $1",
            [result.runId],
          );
          assertExists(run);
          assertEquals(run!.status, "escalated");
          assertEquals(run!.context._escalation_reason, "Could not find order in sheet");

          const thread = await queryOne<{ status: string }>(
            "SELECT status FROM threads WHERE id = $1",
            [fixture.threadId],
          );
          assertEquals(thread!.status, "in_review");
        } finally {
          await cleanupFixture(fixture.workspaceId);
        }
      });
      ```
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> deno test --allow-net --allow-env --allow-read services/playbook/executor_test.ts`
      Expect failure: `escalateHandler`/`getHandler` path already returns the escalate decision
      (Step 3 landed it), but `advanceRun`'s switch has no `case "escalate"` yet, so it falls
      into no matching case, `status` never changes from `"running"`, and the assertions on
      `result.status`/`run.status` fail (`"running"` vs expected `"escalated"`).
- [ ] Implement. In `api/services/playbook/executor.ts`, replace `escalateRunDueToLoop`
      (currently lines ~70-100) with a shared `finalizeEscalation` plus a thin
      `escalateRunDueToLoop` that just adds the loop-detection audit row:
      ```ts
      /**
       * The single place status='escalated' gets written. Every escalation path -
       * loop detection, the 50-step cap, the escalate decision, human rejections,
       * and the timeout/retry workers - ends here, so every escalation looks
       * identical: real reason recorded, thread surfaced for review, alert fired,
       * SSE published. Exported so routes/playbooks.ts and the workers can call it
       * directly instead of re-implementing this by hand.
       */
      export async function finalizeEscalation(
        runId: number,
        threadId: number,
        workspaceId: number,
        variables: Record<string, unknown>,
        currentStepId: string | null,
        reason: string,
      ): Promise<RunResult> {
        variables._escalation_reason = reason;
        const updatedRun = await queryOne<PlaybookRun & { playbook_name: string }>(
          `UPDATE playbook_runs pr
           SET status = 'escalated', current_step_id = $1, context = $2
           FROM playbooks p
           WHERE pr.playbook_id = p.id AND pr.id = $3
           RETURNING pr.*, p.name AS playbook_name`,
          [currentStepId, JSON.stringify(variables), runId],
        );
        await execute("UPDATE threads SET status = 'in_review' WHERE id = $1", [threadId]);
        logger.error("playbook.run_escalated", { run_id: runId, thread_id: threadId, reason });
        await sendAlert(workspaceId, "run_escalated", { run_id: runId, thread_id: threadId, reason })
          .catch(() => {});
        if (updatedRun) {
          publish({ type: "run_updated", workspaceId, threadId, run: updatedRun });
        }
        const threadItem = await fetchThreadListItem(threadId, workspaceId);
        if (threadItem) {
          publish({
            type: "thread_updated",
            workspaceId,
            thread: threadItem as unknown as Record<string, unknown>,
          });
        }
        return { runId, status: "escalated", currentStepId, context: variables };
      }

      /**
       * Mark a run as escalated due to loop detection or the 50-execution cap.
       * Inserts a sentinel step execution record for visibility in the review
       * queue - there is no real step to attribute the escalation to.
       */
      async function escalateRunDueToLoop(
        runId: number,
        threadId: number,
        workspaceId: number,
        variables: Record<string, unknown>,
        currentStepId: string | null,
        reason: string,
      ): Promise<RunResult> {
        await execute(
          `INSERT INTO playbook_step_executions (run_id, step_id, step_type, status, output, completed_at)
           VALUES ($1, '_loop_detected', '_loop_detected', 'failed', $2, NOW())`,
          [runId, JSON.stringify({ reason })],
        );
        return finalizeEscalation(runId, threadId, workspaceId, variables, currentStepId, reason);
      }
      ```
      The two call sites of `escalateRunDueToLoop` (loop detection and the 50-execution cap,
      inside the `while` loop) are unchanged - same signature, same call.

      Now add the new switch case. In the `switch (result.decision.action)` block, insert a new
      case right after `case "complete": { ... }` and before `case "fail": {`:
      ```ts
        case "escalate": {
          return await finalizeEscalation(
            runId,
            run.thread_id,
            run.workspace_id,
            variables,
            currentStepId,
            result.decision.reason,
          );
        }
      ```
      Finally, clean up the now-dead branch at the bottom of `advanceRun` (after the `while`
      loop). Replace:
      ```ts
        } else if (status === "escalated" || status === "failed") {
          await execute("UPDATE threads SET status = 'in_review' WHERE id = $1", [run.thread_id]);
          if (status === "escalated") {
            await sendAlert(run.workspace_id, "run_escalated", {
              run_id: runId,
              thread_id: run.thread_id,
            }).catch(() => {});
          }
        }
      ```
      with:
      ```ts
        } else if (status === "failed") {
          // 'escalated' can no longer reach here - every escalation path returns
          // early via finalizeEscalation now (loop detection, the 50-cap, and the
          // escalate decision case above all do). Task 7 adds the run_failed alert
          // here.
          await execute("UPDATE threads SET status = 'in_review' WHERE id = $1", [run.thread_id]);
        }
      ```
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> deno test --allow-net --allow-env --allow-read services/playbook/executor_test.ts`
      Expect: `ok | 1 passed | 0 failed`.
- [ ] `git add api/services/playbook/executor.ts api/services/playbook/executor_test.ts && git commit -m "Add finalizeEscalation and wire the escalate decision through advanceRun"`

#### Step 7: timeout_worker.ts and retry_worker.ts converge on finalizeEscalation too (TDD) [DB]

Both workers currently hand-roll their own "mark escalated" logic with raw `execute()` calls
and never publish `run_updated` over SSE - a gap section 5 calls out ("SSE events on all state
transitions"). Routing them through `finalizeEscalation` fixes that for free.

- [ ] Write the failing tests. Create `api/services/playbook/timeout_worker_test.ts`:
      ```ts
      import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
      import { execute, queryOne } from "../../db/client.ts";
      import type { EscalateStep } from "./types.ts";
      import { checkSilentRuns } from "./timeout_worker.ts";
      import { cleanupFixture, createTestFixture, createTestRun } from "./test-helpers.ts";

      Deno.test("checkSilentRuns escalates a run waiting past customer_silence_hours [DB]", async () => {
        const steps: EscalateStep[] = [{ id: "wait_step", type: "escalate", reason: "unused" }];
        const fixture = await createTestFixture(steps);
        try {
          await execute("UPDATE playbooks SET customer_silence_hours = 0 WHERE id = $1", [
            fixture.playbookId,
          ]);
          const runId = await createTestRun(fixture, steps, "wait_step", "waiting_for_customer");

          await checkSilentRuns();

          const run = await queryOne<{ status: string; context: Record<string, unknown> }>(
            "SELECT status, context FROM playbook_runs WHERE id = $1",
            [runId],
          );
          assertEquals(run!.status, "escalated");
          assertEquals(run!.context._escalation_reason, "Customer silence timeout after 0 hours");

          const thread = await queryOne<{ status: string }>(
            "SELECT status FROM threads WHERE id = $1",
            [fixture.threadId],
          );
          assertEquals(thread!.status, "in_review");
        } finally {
          await cleanupFixture(fixture.workspaceId);
        }
      });
      ```
      Create `api/services/playbook/retry_worker_test.ts`:
      ```ts
      import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
      import { execute, queryOne } from "../../db/client.ts";
      import type { EscalateStep } from "./types.ts";
      import { processRetryRuns } from "./retry_worker.ts";
      import { cleanupFixture, createTestFixture, createTestRun } from "./test-helpers.ts";

      Deno.test("processRetryRuns escalates via finalizeEscalation once retries are exhausted [DB]", async () => {
        const steps: EscalateStep[] = [{ id: "step_1", type: "escalate", reason: "unused" }];
        // No OAuth token - advanceRun's setup will throw deterministically without any
        // network call, simulating a genuinely exhausted retry.
        const fixture = await createTestFixture(steps, { withOAuthToken: false });
        try {
          const runId = await createTestRun(fixture, steps, "step_1", "retrying", {});
          await execute(
            "UPDATE playbook_runs SET retry_count = 4, next_retry_at = NOW() - interval '1 minute' WHERE id = $1",
            [runId],
          );

          await processRetryRuns();

          const run = await queryOne<{ status: string; context: Record<string, unknown> }>(
            "SELECT status, context FROM playbook_runs WHERE id = $1",
            [runId],
          );
          assertEquals(run!.status, "escalated");
          assertExists(run!.context._escalation_reason);

          const thread = await queryOne<{ status: string }>(
            "SELECT status FROM threads WHERE id = $1",
            [fixture.threadId],
          );
          assertEquals(thread!.status, "in_review");
        } finally {
          await cleanupFixture(fixture.workspaceId);
        }
      });
      ```
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> deno test --allow-net --allow-env --allow-read services/playbook/timeout_worker_test.ts services/playbook/retry_worker_test.ts`
      Expect failure: `checkSilentRuns` and `processRetryRuns` are not exported yet (TS2305 import
      errors - both functions are currently module-private).
- [ ] Implement. Replace `api/services/playbook/timeout_worker.ts` in full:
      ```ts
      /**
       * Timeout worker - escalates playbook runs that have been waiting for a customer
       * reply longer than the playbook's configured customer_silence_hours.
       * Runs every 30 minutes.
       */
      import { query } from "../../db/client.ts";
      import { logger } from "../logger.ts";
      import { finalizeEscalation } from "./executor.ts";

      interface SilentRun {
        id: number;
        thread_id: number;
        workspace_id: number;
        current_step_id: string | null;
        context: Record<string, unknown> | string;
        customer_silence_hours: number;
      }

      /** Exported for the timeout_worker_test.ts integration test - not meant to be
       *  called outside the worker's own tick except by tests. */
      export async function checkSilentRuns(): Promise<void> {
        const runs = await query<SilentRun>(
          `SELECT r.id, r.thread_id, r.workspace_id, r.current_step_id, r.context, p.customer_silence_hours
           FROM playbook_runs r
           JOIN playbooks p ON p.id = r.playbook_id
           WHERE r.status = 'waiting_for_customer'
             AND r.updated_at < NOW() - (p.customer_silence_hours || ' hours')::interval`,
          [],
        );

        if (runs.length === 0) return;

        logger.info("timeout_worker.found_silent_runs", { count: runs.length });

        for (const run of runs) {
          const reason = `Customer silence timeout after ${run.customer_silence_hours} hours`;
          const variables = typeof run.context === "string"
            ? JSON.parse(run.context)
            : { ...run.context };

          await finalizeEscalation(
            run.id,
            run.thread_id,
            run.workspace_id,
            variables,
            run.current_step_id,
            reason,
          );
        }
      }

      export function startTimeoutWorker(): void {
        const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

        const tick = () => {
          checkSilentRuns().catch((err) => {
            logger.error("timeout_worker.error", { error: String(err) });
          });
        };

        tick(); // Run immediately on startup
        setInterval(tick, INTERVAL_MS);
        logger.info("timeout_worker.started", { interval_minutes: 30 });
      }
      ```
      In `api/services/playbook/retry_worker.ts`, replace the imports and `processRetryRuns`
      (`~line 12-71`), keeping `processFailedIngestions` and `startRetryWorker` as they are for now
      (Task 7 touches `processFailedIngestions`):
      ```ts
      import { query, execute } from "../../db/client.ts";
      import { logger } from "../logger.ts";
      import { sendAlert } from "../alerts.ts";
      import { advanceRun, finalizeEscalation } from "./executor.ts";
      import { retryIngest } from "../gmail.ts";

      const MAX_RETRIES = 5;
      const MAX_INGESTION_ATTEMPTS = 3;

      interface RetryRun {
        id: number;
        thread_id: number;
        workspace_id: number;
        retry_count: number;
        current_step_id: string | null;
        context: Record<string, unknown> | string;
      }

      /** Exported for retry_worker_test.ts - not meant to be called outside the
       *  worker's own tick except by tests. */
      export async function processRetryRuns(): Promise<void> {
        const runs = await query<RetryRun>(
          `SELECT id, thread_id, workspace_id, retry_count, current_step_id, context
           FROM playbook_runs
           WHERE status = 'retrying'
             AND next_retry_at <= NOW()
             AND retry_count < $1`,
          [MAX_RETRIES],
        );

        for (const run of runs) {
          try {
            logger.info("retry_worker.advancing_run", { run_id: run.id, retry_count: run.retry_count });
            await advanceRun(run.id);
          } catch (err) {
            logger.error("retry_worker.advance_failed", { run_id: run.id, error: String(err) });

            if (run.retry_count >= MAX_RETRIES - 1) {
              const variables = typeof run.context === "string"
                ? JSON.parse(run.context)
                : { ...run.context };
              await finalizeEscalation(
                run.id,
                run.thread_id,
                run.workspace_id,
                variables,
                run.current_step_id,
                `Exhausted ${MAX_RETRIES} retries: ${String(err)}`,
              );
            }
          }
        }
      }
      ```
      Leave `processFailedIngestions` and `startRetryWorker` untouched in this step; just update
      `startRetryWorker`'s call site if needed (it already calls `processRetryRuns()` by name,
      which still resolves - no change needed there).
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> deno test --allow-net --allow-env --allow-read services/playbook/timeout_worker_test.ts services/playbook/retry_worker_test.ts`
      Expect: both files `ok | 1 passed | 0 failed`.
- [ ] `git add api/services/playbook/timeout_worker.ts api/services/playbook/timeout_worker_test.ts api/services/playbook/retry_worker.ts api/services/playbook/retry_worker_test.ts && git commit -m "Route timeout and retry worker escalations through finalizeEscalation"`

#### Step 8: playbooks.ts - converge the two reject flows (TDD) [DB+AUTH]

The `manual_approval` reject flow already lands on `finalizeEscalation` indirectly (it routes to
`on_reject`, which is typically an `escalate` step, and Steps 3+6 above already wired that step's
decision through `finalizeEscalation`) - it needs no route change. Only the pending-send reject
flow (`ask_customer`/`send_reply` steps paused for approval) needs fixing: today it sets
`status='escalated'` with a bare UPDATE, no reason recorded, no thread `in_review`, no alert.

- [ ] Write the failing tests. Create `api/routes/playbooks_test.ts`:
      ```ts
      import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
      import { Hono } from "hono";
      import { queryOne } from "../db/client.ts";
      import { startRun } from "../services/playbook/executor.ts";
      import { AppError, ErrorResponse } from "../types/index.ts";
      import type {
        AskCustomerStep,
        CompleteStep,
        EscalateStep,
        ManualApprovalStep,
        PlaybookStep,
      } from "../services/playbook/types.ts";
      import { cleanupFixture, createTestFixture } from "../services/playbook/test-helpers.ts";
      import { playbooksRouter } from "./playbooks.ts";

      // Requires API_SECRET set in the shell BEFORE `deno test` starts - middleware/auth.ts
      // reads it once at module load, so setting it inside this file would be too late.
      const API_SECRET = Deno.env.get("API_SECRET");
      if (!API_SECRET) {
        throw new Error("playbooks_test.ts requires API_SECRET set in the environment");
      }

      // playbooksRouter is normally mounted under the top-level `app` in main.ts,
      // which registers app.onError to map AppError -> the right HTTP status.
      // main.ts can't be imported directly in a test (it runs DB migrations and
      // starts a real server at import time), so wrap the router the same way
      // here, mirroring main.ts's onError exactly. Keep this in sync if that
      // handler ever changes - verified this matters by checking Hono's docs:
      // a sub-app has no error mapping of its own until one is registered on it.
      const testApp = new Hono();
      testApp.onError((err, c) => {
        if (err instanceof AppError) {
          const body: ErrorResponse = {
            error: { message: err.message, detail: err.detail, status: err.statusCode },
          };
          return c.json(body, err.statusCode as 400 | 401 | 403 | 404 | 409 | 422 | 500);
        }
        return c.json({ error: { message: "Internal server error", status: 500 } }, 500);
      });
      testApp.route("/", playbooksRouter);

      function authedRequest(path: string, init: RequestInit = {}): Promise<Response> {
        return testApp.request(path, {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${API_SECRET}` },
        });
      }

      Deno.test("POST /runs/:id/reject on a pending send escalates with a human-rejection reason [DB+AUTH]", async () => {
        const steps: PlaybookStep[] = [
          {
            id: "ask_1",
            type: "ask_customer",
            message: "Please confirm your order number.",
            on_reply_goto: "complete_1",
            require_approval: true,
          } satisfies AskCustomerStep,
          { id: "complete_1", type: "complete" } satisfies CompleteStep,
        ];
        const fixture = await createTestFixture(steps);
        try {
          const started = await startRun(fixture.workspaceId, fixture.threadId, fixture.playbookId);
          assertEquals(started.status, "waiting_for_human");

          const res = await authedRequest(`/runs/${started.runId}/reject`, { method: "POST" });
          assertEquals(res.status, 200);
          const body = await res.json();
          assertEquals(body.run.status, "escalated");

          const run = await queryOne<{ status: string; context: Record<string, unknown> }>(
            "SELECT status, context FROM playbook_runs WHERE id = $1",
            [started.runId],
          );
          assertEquals(run!.status, "escalated");
          assertEquals(
            run!.context._escalation_reason,
            `Rejected by human: draft for ask_customer step "ask_1" was not approved`,
          );

          const thread = await queryOne<{ status: string }>(
            "SELECT status FROM threads WHERE id = $1",
            [fixture.threadId],
          );
          assertEquals(thread!.status, "in_review");
        } finally {
          await cleanupFixture(fixture.workspaceId);
        }
      });

      Deno.test("POST /runs/:id/reject on a manual_approval step lands in the same terminal shape [DB+AUTH]", async () => {
        const steps: PlaybookStep[] = [
          {
            id: "approval_1",
            type: "manual_approval",
            reason: "Process refund in Stripe",
            on_approve: "complete_1",
            on_reject: "escalate_1",
          } satisfies ManualApprovalStep,
          {
            id: "escalate_1",
            type: "escalate",
            reason: "static fallback reason - should not appear",
          } satisfies EscalateStep,
          { id: "complete_1", type: "complete" } satisfies CompleteStep,
        ];
        const fixture = await createTestFixture(steps);
        try {
          const started = await startRun(fixture.workspaceId, fixture.threadId, fixture.playbookId);
          assertEquals(started.status, "waiting_for_human");

          const res = await authedRequest(`/runs/${started.runId}/reject`, { method: "POST" });
          assertEquals(res.status, 200);
          const body = await res.json();
          assertEquals(body.run.status, "escalated");

          const run = await queryOne<{ status: string; context: Record<string, unknown> }>(
            "SELECT status, context FROM playbook_runs WHERE id = $1",
            [started.runId],
          );
          assertEquals(run!.status, "escalated");
          assertEquals(
            run!.context._escalation_reason,
            "Rejected by human: approval_1 (Process refund in Stripe)",
          );

          const thread = await queryOne<{ status: string }>(
            "SELECT status FROM threads WHERE id = $1",
            [fixture.threadId],
          );
          assertEquals(thread!.status, "in_review");
        } finally {
          await cleanupFixture(fixture.workspaceId);
        }
      });
      ```
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> API_SECRET=test-secret deno test --allow-net --allow-env --allow-read routes/playbooks_test.ts`
      Expect the first test to fail: `run.context._escalation_reason` is `undefined` (today's
      pending-send reject path never writes a reason or updates the thread). Expect the second
      test to already pass (flow 2 was fixed by Steps 3+6).
- [ ] Implement. In `api/routes/playbooks.ts`, add `finalizeEscalation` to the executor import
      at the top of the file:
      ```ts
      import { getRunSteps, finalizeEscalation } from "../services/playbook/executor.ts";
      ```
      Then replace the pending-send branch inside the `/runs/:runId/reject` handler (currently):
      ```ts
        if (currentStep.type === "ask_customer" || currentStep.type === "send_reply") {
          await execute(
            "UPDATE playbook_runs SET status = 'escalated', updated_at = NOW() WHERE id = $1",
            [runId],
          );
          const updated = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [
            runId,
          ]);
          publish({
            type: "run_updated",
            workspaceId: run.workspace_id,
            threadId: run.thread_id,
            run: { ...run, status: "escalated" },
          });
          const rejEscThreadItem = await fetchThreadListItem(run.thread_id, run.workspace_id);
          if (rejEscThreadItem) {
            publish({
              type: "thread_updated",
              workspaceId: run.workspace_id,
              thread: rejEscThreadItem as unknown as Record<string, unknown>,
            });
          }
          return c.json({ run: updated, result: { action: "escalated" } });
        }
      ```
      with:
      ```ts
        if (currentStep.type === "ask_customer" || currentStep.type === "send_reply") {
          // Converges with the manual_approval reject flow below: both end up calling
          // finalizeEscalation, so both record a real reason, surface the thread for
          // review, fire the alert, and publish SSE the same way.
          const currentContext = typeof run.context === "string"
            ? JSON.parse(run.context)
            : { ...run.context };
          const rejectionReason =
            `Rejected by human: draft for ${currentStep.type} step "${currentStep.id}" was not approved`;
          await finalizeEscalation(
            runId,
            run.thread_id,
            run.workspace_id,
            currentContext,
            run.current_step_id,
            rejectionReason,
          );
          const updated = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [
            runId,
          ]);
          return c.json({ run: updated, result: { action: "escalated", reason: rejectionReason } });
        }
      ```
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> API_SECRET=test-secret deno test --allow-net --allow-env --allow-read routes/playbooks_test.ts`
      Expect: `ok | 2 passed | 0 failed`.
- [ ] `git add api/routes/playbooks.ts api/routes/playbooks_test.ts && git commit -m "Converge pending-send and manual_approval reject flows on finalizeEscalation"`

Task 5 done. Run the full pure-function suite once before moving on:
`cd api && deno test --allow-net --allow-env --allow-read services/playbook/handlers/` should
show `ok` for `escalate_test.ts`, `ask_customer_test.ts`, `evaluate_test.ts`, `triage_test.ts`
with no DB needed for any of them.

---

### Task 6: Inbound-during-run lifecycle

**Files:**
- Modify: `api/services/gmail.ts` (imports `~line 1-16`; message-insert loop `~line 255-284`;
  outbound-check + activeRun block `~line 286-323`; new exports inserted after `ingestMessage`)
- Modify: `api/services/categorisation.ts` (doc comment on `cancelActiveRunsForRecategorisation`, `~line 294-297`)
- Create: `api/services/gmail_test.ts`

**Interfaces:**
- Consumes: `RunStatus` from `api/services/playbook/types.ts`; `advanceRun` (already exported
  from `executor.ts`, was previously unused in `gmail.ts`).
- Produces: `resolveInboundRunAction`, `appendMessageToWaitingRun`, `InboundRunAction` (all
  listed in PRODUCED INTERFACES above), exported from `gmail.ts`.

No DB or Gmail-API mocking exists in this codebase, and `ingestMessage` calls
`getGoogleAccessToken` (a real Google OAuth refresh) before it ever reaches the branching logic
below - there is no seam to fake that without a real network double. So this task's automated
coverage is the full decision table as a pure function (every state, every case, zero I/O), plus
the one genuinely pure data transform (`appendMessageToWaitingRun`). The DB-mutating wiring
around them is verified manually at the end of the task, per the repo's own convention ("check
postgres after writes").

#### Step 1: resolveInboundRunAction and appendMessageToWaitingRun (TDD)

- [ ] Write the failing test. Create `api/services/gmail_test.ts`:
      ```ts
      import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
      import { appendMessageToWaitingRun, resolveInboundRunAction } from "./gmail.ts";

      Deno.test("resolveInboundRunAction resumes a waiting_for_customer run", () => {
        assertEquals(resolveInboundRunAction("waiting_for_customer"), "resume");
      });

      Deno.test("resolveInboundRunAction attaches to a waiting_for_human run instead of cancelling it", () => {
        assertEquals(resolveInboundRunAction("waiting_for_human"), "attach_to_waiting_human");
      });

      Deno.test("resolveInboundRunAction requeues a waiting_to_send run instead of losing the delayed reply", () => {
        assertEquals(resolveInboundRunAction("waiting_to_send"), "requeue_send");
      });

      Deno.test("resolveInboundRunAction leaves a running run alone - the next advanceRun sees the message", () => {
        assertEquals(resolveInboundRunAction("running"), "store_only");
      });

      Deno.test("resolveInboundRunAction leaves a retrying run alone", () => {
        assertEquals(resolveInboundRunAction("retrying"), "store_only");
      });

      Deno.test("resolveInboundRunAction allows recategorisation when there is no active run", () => {
        assertEquals(resolveInboundRunAction(null), "none");
      });

      Deno.test("resolveInboundRunAction allows recategorisation for every terminal status", () => {
        assertEquals(resolveInboundRunAction("complete"), "none");
        assertEquals(resolveInboundRunAction("failed"), "none");
        assertEquals(resolveInboundRunAction("escalated"), "none");
        assertEquals(resolveInboundRunAction("cancelled"), "none");
      });

      Deno.test("appendMessageToWaitingRun creates the array on the first inbound message", () => {
        const result = appendMessageToWaitingRun({}, {
          message_id: 42,
          received_at: "2026-07-20T00:00:00.000Z",
        });
        assertEquals(result._messages_since_draft, [
          { message_id: 42, received_at: "2026-07-20T00:00:00.000Z" },
        ]);
      });

      Deno.test("appendMessageToWaitingRun appends without losing prior entries", () => {
        const existing = {
          _messages_since_draft: [{ message_id: 1, received_at: "2026-07-19T00:00:00.000Z" }],
        };
        const result = appendMessageToWaitingRun(existing, {
          message_id: 2,
          received_at: "2026-07-20T00:00:00.000Z",
        });
        assertEquals(result._messages_since_draft, [
          { message_id: 1, received_at: "2026-07-19T00:00:00.000Z" },
          { message_id: 2, received_at: "2026-07-20T00:00:00.000Z" },
        ]);
      });
      ```
      No `DATABASE_URL` needed - `db/client.ts`'s connection pool is created lazily on first
      query, and none of these tests trigger a query.
- [ ] Run `cd api && deno test --allow-net --allow-env --allow-read services/gmail_test.ts`
      Expect failure: `resolveInboundRunAction` and `appendMessageToWaitingRun` do not exist yet
      (import error).
- [ ] Implement. In `api/services/gmail.ts`, change the imports at the top of the file:
      ```ts
      import { execute, query, queryOne, transaction } from "../db/client.ts";
      import { AppError, Category, GmailMessage, GmailThread, Message, Setting } from "../types/index.ts";
      import { categoriseAndDraft, categoriseFromGmailLabels } from "./categorisation.ts";
      import { getGoogleAccessToken } from "./google-auth.ts";
      import { advanceRun, resumeRun } from "./playbook/executor.ts";
      import type { PlaybookRun, RunStatus } from "./playbook/types.ts";
      import { logger } from "./logger.ts";
      import { rateLimitedCall } from "./rate_limit.ts";
      import { publish } from "./event-bus.ts";
      import { fetchThreadListItem } from "../db/queries.ts";
      import { getReadableEmailText } from "./email-text.ts";
      ```
      Then insert the following right after the `ingestMessage` function's closing brace (i.e.
      right before `interface ParsedGmailMessage`):
      ```ts
      export type InboundRunAction =
        | "resume"
        | "attach_to_waiting_human"
        | "requeue_send"
        | "store_only"
        | "none";

      /**
       * Maps a thread's active playbook run status to what an inbound customer
       * message should do to it. The rule behind every branch (design doc 3.2): a
       * new message never destroys an active run. Only "none" (no active run, or a
       * terminal one) allows the thread to fall through to recategorisation.
       */
      export function resolveInboundRunAction(runStatus: RunStatus | null): InboundRunAction {
        switch (runStatus) {
          case "waiting_for_customer":
            return "resume";
          case "waiting_for_human":
            return "attach_to_waiting_human";
          case "waiting_to_send":
            return "requeue_send";
          case "running":
          case "retrying":
            return "store_only";
          default:
            // null (no active run), complete, failed, escalated, cancelled.
            return "none";
        }
      }

      /**
       * Appends a newly-arrived message marker to a waiting_for_human run's context
       * so the approval UI can show "customer replied since this draft was written"
       * and offer regeneration (Task 8). Pure so the append logic is unit-testable
       * without a database round trip.
       */
      export function appendMessageToWaitingRun(
        context: Record<string, unknown>,
        entry: { message_id: number | null; received_at: string },
      ): Record<string, unknown> {
        const existing = Array.isArray(context._messages_since_draft)
          ? context._messages_since_draft
          : [];
        return { ...context, _messages_since_draft: [...existing, entry] };
      }

      async function attachMessageToWaitingRun(
        run: PlaybookRun,
        messageId: number | null,
        receivedAt: string,
      ): Promise<void> {
        const currentContext = typeof run.context === "string"
          ? JSON.parse(run.context)
          : { ...run.context };
        const updatedContext = appendMessageToWaitingRun(currentContext, {
          message_id: messageId,
          received_at: receivedAt,
        });
        const updatedRun = await queryOne<PlaybookRun & { playbook_name: string }>(
          `UPDATE playbook_runs pr SET context = $1
           FROM playbooks p WHERE pr.playbook_id = p.id AND pr.id = $2
           RETURNING pr.*, p.name AS playbook_name`,
          [JSON.stringify(updatedContext), run.id],
        );
        if (updatedRun) {
          publish({
            type: "run_updated",
            workspaceId: run.workspace_id,
            threadId: run.thread_id,
            run: updatedRun,
          });
        }
        logger.info("gmail.inbound_during_waiting_for_human", { run_id: run.id, thread_id: run.thread_id });
      }

      async function requeuePendingSend(run: PlaybookRun): Promise<void> {
        // current_step_id already points at the send_reply step - a paused
        // waiting_to_send run never advances its cursor (see executor.ts's pause
        // case). Clearing send_after and setting the run back to running re-enters
        // that same step, which reloads the full transcript (including this new
        // message) and re-queues the delayed send.
        await execute(
          "UPDATE playbook_runs SET status = 'running', send_after = NULL WHERE id = $1",
          [run.id],
        );
        logger.info("gmail.inbound_during_waiting_to_send", { run_id: run.id, thread_id: run.thread_id });
        try {
          await advanceRun(run.id);
        } catch (err) {
          logger.error("gmail.requeue_send_failed", { run_id: run.id, error: String(err) });
        }
      }
      ```
- [ ] Run `cd api && deno test --allow-net --allow-env --allow-read services/gmail_test.ts`
      Expect: `ok | 9 passed | 0 failed`.
- [ ] `git add api/services/gmail.ts api/services/gmail_test.ts && git commit -m "Add inbound-run routing decision and context-append helper for gmail ingest"`

#### Step 2: Wire the decision into ingestMessage

No new automated test here - this is the untestable-without-mocking wiring described above.
Verified manually at the end of this task.

- [ ] In `api/services/gmail.ts`, find the message-insert loop inside `ingestMessage` (the `for
      (const parsedMessage of parsedMessages)` loop that inserts into `messages`). Capture the id
      of the specific message that triggered this ingest - `currentMessage`, not the whole
      thread - so it can be attached to a waiting run's context later:
      ```ts
        // Gmail gives us the whole conversation here. Store every missing message before
        // categorisation so AI/playbooks can see context from threads that existed pre-launch.
        let currentInsertedMessageId: number | null = null;
        for (const parsedMessage of parsedMessages) {
          const insertedMsg = await queryOne<Message>(
            `INSERT INTO messages
               (thread_id, gmail_message_id, from_address, body_plain, body_html, received_at, direction, message_id_header)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (gmail_message_id) DO NOTHING
             RETURNING *`,
            [
              threadRow.id,
              parsedMessage.gmailMessageId,
              parsedMessage.from,
              parsedMessage.plain,
              parsedMessage.html,
              parsedMessage.receivedAt,
              parsedMessage.direction,
              parsedMessage.messageIdHeader,
            ],
          );

          if (insertedMsg) {
            publish({
              type: "message_created",
              workspaceId,
              threadId: threadRow.id,
              message: insertedMsg,
            });
            if (parsedMessage.gmailMessageId === currentMessage.gmailMessageId) {
              currentInsertedMessageId = insertedMsg.id;
            }
          }
        }
      ```
- [ ] Replace the outbound-check-and-activeRun block right after it (currently ends with `await
      categoriseAndDraft(threadRow.id);` and the function's closing brace):
      ```ts
        // Only run categorisation for inbound messages. Outbound messages (sent by this
        // app or by the user) must not trigger another draft or auto-reply loop.
        if (currentMessage.direction === "outbound") {
          logger.debug("gmail.skip_outbound", { gmail_message_id: gmailMessageId });
          return;
        }

        // A thread with any non-terminal run is never recategorised (design doc 3.2) - a new
        // inbound message must never destroy an active run. Recategorisation below only ever
        // runs when there is no active run for this thread.
        const activeRun = await queryOne<PlaybookRun>(
          `SELECT * FROM playbook_runs
           WHERE thread_id = $1
             AND status IN ('running', 'waiting_for_customer', 'waiting_for_human', 'waiting_to_send', 'retrying')
           ORDER BY created_at DESC LIMIT 1`,
          [threadRow.id],
        );

        switch (resolveInboundRunAction(activeRun?.status ?? null)) {
          case "resume": {
            logger.info("gmail.resume_playbook_run", { thread_id: threadRow.id, run_id: activeRun!.id });
            try {
              await resumeRun(activeRun!.id);
            } catch (err) {
              logger.error("gmail.resume_run_failed", { run_id: activeRun!.id, error: String(err) });
            }
            return;
          }
          case "attach_to_waiting_human": {
            await attachMessageToWaitingRun(activeRun!, currentInsertedMessageId, currentMessage.receivedAt);
            return;
          }
          case "requeue_send": {
            await requeuePendingSend(activeRun!);
            return;
          }
          case "store_only": {
            logger.info("gmail.inbound_during_active_run", {
              thread_id: threadRow.id,
              run_id: activeRun!.id,
              run_status: activeRun!.status,
            });
            return;
          }
          case "none":
            break; // no active run - fall through to recategorisation
        }

        const gmailLabelsAuthoritative = await isGmailLabelsAuthoritative(workspaceId);
        if (gmailLabelsAuthoritative) {
          logger.info("gmail.labels_authoritative_categorisation", {
            thread_id: threadRow.id,
            gmail_label_ids: currentMessage.labelIds,
          });
          await categoriseFromGmailLabels(threadRow.id, currentMessage.labelIds);
          return;
        }

        // Run the AI categorisation pipeline (which may route to a playbook for new threads).
        await categoriseAndDraft(threadRow.id);
      }
      ```
- [ ] Run `cd api && deno check services/gmail.ts` - expect it to pass (typecheck only, this
      step has no automated behavioral test per the note above).
- [ ] `git add api/services/gmail.ts && git commit -m "Route inbound messages during an active run through resolveInboundRunAction"`

#### Step 3: categorisation.ts - document the now-structural invariant

`cancelActiveRunsForRecategorisation` needed no behavior change: after Step 2, `gmail.ts`'s
ingest path only reaches `categoriseAndDraft`/`categoriseFromGmailLabels` when
`resolveInboundRunAction` returns `"none"`, which by definition means there is no active
non-terminal run for that thread - so `cancelActiveRunsForRecategorisation`'s query finds zero
rows on the ingest path already. The one other caller, `POST /threads/:id/recategorise`
(`api/routes/threads.ts:154`), is a deliberate human action and is unaffected - out of scope for
"a new inbound message never destroys an active run" (that rule is specifically about messages,
not explicit human overrides).

- [ ] Update the doc comment on `cancelActiveRunsForRecategorisation` in
      `api/services/categorisation.ts` (currently has no comment) to record the invariant:
      ```ts
      /**
       * Cancels any active run before a fresh category assignment. Reachable from two
       * places: the explicit "recategorise this thread" route (a deliberate human
       * override - always allowed to cancel) and this file's own routeThreadToCategory,
       * called from the automatic ingest pipeline in gmail.ts. As of the inbound-run
       * lifecycle rework (design doc 3.2), gmail.ts's ingestMessage only reaches
       * routeThreadToCategory when resolveInboundRunAction returns "none" - i.e. there
       * is no active run left to cancel - so this function is structurally a no-op on
       * the automatic path and only ever does real work on the explicit route.
       */
      async function cancelActiveRunsForRecategorisation(
      ```
- [ ] Run `cd api && deno check services/categorisation.ts` - expect it to pass (comment-only change).
- [ ] `git add api/services/categorisation.ts && git commit -m "Document the cancel-on-recategorise invariant after the inbound-run rework"`

#### Manual verification (required before calling Task 6 done - no automated test covers this)

1. Start the stack locally (`docker-compose up -d`, or your usual dev flow) with a real
   connected Gmail account and at least one active playbook that has a `require_approval`
   `ask_customer` step.
2. Trigger a run into `waiting_for_human`: send an inbound email that matches that category.
3. Check the run: `SELECT id, status, current_step_id FROM playbook_runs WHERE thread_id = <id> ORDER BY created_at DESC LIMIT 1;`
   Confirm `status = 'waiting_for_human'`. Note the run id.
4. Send a follow-up email into the same thread from the test customer address (a genuine second
   message, not a reply to the draft - the draft was never sent).
5. After the webhook fires (or trigger ingestion manually), re-run:
   `SELECT status, context -> '_messages_since_draft' AS pending FROM playbook_runs WHERE id = <run_id>;`
   Expect: `status` still `waiting_for_human` (unchanged), `pending` is a JSON array with one new
   `{message_id, received_at}` entry. Confirm via the dashboard that the run was NOT cancelled
   and no new run was created for the thread (`SELECT count(*) FROM playbook_runs WHERE thread_id = <id>;` should still be 1).
6. Repeat with a playbook whose `send_reply` step has `delay_seconds` set (e.g. 300) to reach
   `waiting_to_send`, then send a follow-up before the delay elapses. Confirm via
   `SELECT status, send_after FROM playbook_runs WHERE id = <run_id>;` that the run went back to
   `running` and then to `waiting_to_send` again with a fresh, later `send_after`, and that the
   step execution's `pending_send` reflects the step re-running (new `created_at` row in
   `playbook_step_executions` for the same `step_id`).

---

### Task 7: Wedge-proofing

**Files:**
- Modify: `api/services/alerts.ts` (`AlertEvent` union, `~line 8-12`)
- Modify: `api/services/playbook/executor.ts` (imports; `advanceRun` setup section `~line 106-165`;
  ctx construction inside the loop `~line 227-240`; post-loop `failed` branch, already touched by
  Task 5 Step 6)
- Modify: `api/services/categorisation.ts` (imports; `startRun` catch, `~line 231-236`)
- Modify: `api/services/playbook/executor_test.ts` (append one test)
- Modify: `api/services/playbook/retry_worker.ts` (export `processFailedIngestions`, `~line 73`)
- Create: `api/services/categorisation_test.ts`
- Create: `api/services/playbook/retry_worker_test.ts` (already created in Task 5 Step 7 - append)

**Interfaces:**
- Consumes: `Message` from `api/types/index.ts` - Phase 1 lands before this task and widens
  `RunContext.messages` to `Message[]`, extending the executor's message query to select
  `thread_id` and `gmail_message_id` so it satisfies that type. This task's message query
  (inside `loadRunSetup`) is written to already match that Phase-1 state, not the pre-Phase-1
  query shown when this file was first read.
- Produces: `AlertEvent` gains `"run_failed"`; `executor.ts` exports `loadRunSetup`,
  `buildRunContext`, and `RunSetup` (listed in PRODUCED INTERFACES above);
  `categorisation.ts` exports `handleStartRunFailure(workspaceId, threadId, err): Promise<void>`;
  `retry_worker.ts` exports `processFailedIngestions`.

#### Step 1: run_failed alert event

- [ ] In `api/services/alerts.ts`, extend the `AlertEvent` union:
      ```ts
      export type AlertEvent =
        | "run_escalated"
        | "run_failed"
        | "ingestion_failed_permanently"
        | "circuit_breaker_opened"
        | "rate_limit_sustained";
      ```
- [ ] Run `cd api && deno check services/alerts.ts` - expect it to pass.
- [ ] `git add api/services/alerts.ts && git commit -m "Add run_failed alert event"`

#### Step 2: advanceRun setup - contain structural failures (TDD) [DB]

- [ ] Write the failing test. Append to `api/services/playbook/executor_test.ts` (the file
      created in Task 5 Step 6 - do not remove the existing test). First, widen the existing
      import line at the top of the file from
      `import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";`
      to itself (it already imports `assertExists` from Task 5 Step 6 - no change needed there).
      Then add this test:
      ```ts
      Deno.test("advanceRun contains a structural setup failure instead of wedging the run [DB]", async () => {
        const steps: EscalateStep[] = [{ id: "step_1", type: "escalate", reason: "unused" }];
        // No OAuth token for this workspace - loadRunSetup's tokenRow check fails
        // deterministically, no network call involved.
        const fixture = await createTestFixture(steps, { withOAuthToken: false });
        try {
          const result = await startRun(fixture.workspaceId, fixture.threadId, fixture.playbookId);
          assertEquals(result.status, "failed");
          assertExists(result.context._failure_reason);

          const run = await queryOne<{ status: string; context: Record<string, unknown> }>(
            "SELECT status, context FROM playbook_runs WHERE id = $1",
            [result.runId],
          );
          assertEquals(run!.status, "failed");
          assertEquals(
            run!.context._failure_reason,
            `Error: No OAuth token for workspace ${fixture.workspaceId}`,
          );

          const thread = await queryOne<{ status: string }>(
            "SELECT status FROM threads WHERE id = $1",
            [fixture.threadId],
          );
          assertEquals(thread!.status, "in_review");
        } finally {
          await cleanupFixture(fixture.workspaceId);
        }
      });
      ```
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> deno test --allow-net --allow-env --allow-read services/playbook/executor_test.ts`
      Expect failure: `startRun`/`advanceRun` currently throws `Error: No OAuth token for
      workspace <id>` uncaught, so the `await startRun(...)` call itself rejects and the test
      fails with an unhandled rejection instead of reaching the assertions.
- [ ] Implement. In `api/services/playbook/executor.ts`, add `RunStatus` to the type import and
      add `Message` (from `api/types/index.ts`, per Phase 1's widened `RunContext.messages`):
      ```ts
      import type {
        AskCustomerStep,
        Playbook,
        PlaybookRun,
        PlaybookStep,
        RunContext,
        RunStatus,
        StepExecution,
        StepResult,
      } from "./types.ts";
      import { AppError, type Message } from "../../types/index.ts";
      ```
      (the existing `import { AppError } from "../../types/index.ts";` line becomes the one
      above - `Message` is type-only, `AppError` stays a value import since it's thrown with `new`).

      Add `RunSetup`, `loadRunSetup`, `buildRunContext`, and `failRun` (place them after
      `finalizeEscalation`/`escalateRunDueToLoop`, before `advanceRun`). There is no bespoke
      `RunMessage` type here - `Message` already carries every field this needs:
      ```ts
      export interface RunSetup {
        playbook: Playbook;
        steps: PlaybookStep[];
        thread: { id: number; gmail_thread_id: string; subject: string; workspace_id: number };
        messages: Message[];
        tokenRow: { email: string };
        senderName: string | null;
        storeProfile: string | null;
      }

      /**
       * Everything advanceRun needs besides the run row itself and the dynamic
       * per-iteration state (variables/currentStepId/status). Extracted so the
       * caller can wrap it in one try/catch (advanceRun) and so regenerate.ts
       * (Task 8) can build the same RunContext outside the run loop without
       * duplicating these seven queries.
       */
      export async function loadRunSetup(run: PlaybookRun): Promise<RunSetup> {
        const playbook = await queryOne<Playbook>(
          "SELECT * FROM playbooks WHERE id = $1",
          [run.playbook_id],
        );
        if (!playbook) throw new Error(`Playbook ${run.playbook_id} not found`);

        const steps = getRunSteps(run, playbook);

        const thread = await queryOne<
          { id: number; gmail_thread_id: string; subject: string; workspace_id: number }
        >(
          "SELECT id, gmail_thread_id, subject, workspace_id FROM threads WHERE id = $1",
          [run.thread_id],
        );
        if (!thread) throw new Error(`Thread ${run.thread_id} not found`);

        // Full Message shape (Phase 1 widened this query to include thread_id and
        // gmail_message_id so RunContext.messages: Message[] is satisfied end to end).
        const messages = await query<Message>(
          "SELECT id, thread_id, gmail_message_id, from_address, body_plain, body_html, direction, received_at, message_id_header FROM messages WHERE thread_id = $1 ORDER BY received_at ASC",
          [run.thread_id],
        );

        const tokenRow = await queryOne<{ email: string }>(
          "SELECT email FROM oauth_tokens WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1",
          [run.workspace_id],
        );
        if (!tokenRow) throw new Error(`No OAuth token for workspace ${run.workspace_id}`);

        const senderNameRow = await queryOne<{ value: string }>(
          "SELECT value FROM settings WHERE workspace_id = $1 AND key = 'sender_name'",
          [run.workspace_id],
        );
        const senderName = senderNameRow?.value ?? null;

        const storeProfile = await getStoreProfile(run.workspace_id);

        return { playbook, steps, thread, messages, tokenRow, senderName, storeProfile };
      }

      /** Pure - builds the per-step RunContext from a loaded setup plus the loop's
       *  dynamic state. No I/O, so both advanceRun's loop and regenerate.ts's
       *  one-shot context build (Task 8) can call it. */
      export function buildRunContext(
        run: PlaybookRun,
        setup: RunSetup,
        variables: Record<string, unknown>,
        currentStepId: string | null,
        status: RunStatus,
      ): RunContext {
        return {
          run: { ...run, context: variables, current_step_id: currentStepId, status },
          playbook: { ...setup.playbook, steps: setup.steps },
          threadId: setup.thread.id,
          workspaceId: run.workspace_id,
          variables,
          messages: setup.messages,
          email: setup.tokenRow.email,
          gmailThreadId: setup.thread.gmail_thread_id,
          subject: setup.thread.subject,
          senderName: setup.senderName,
          storeProfile: setup.storeProfile,
        };
      }

      /**
       * The other terminal write path alongside finalizeEscalation: for genuine
       * structural failures (missing thread, no OAuth token, a playbook removed
       * out from under a run) rather than a deliberate escalation. Same shape -
       * real reason recorded, thread surfaced, alert fired, SSE published - so a
       * run never wedges in 'running' with nothing visible to a human.
       */
      async function failRun(
        runId: number,
        threadId: number,
        workspaceId: number,
        reason: string,
      ): Promise<RunResult> {
        const updatedRun = await queryOne<PlaybookRun & { playbook_name: string }>(
          `UPDATE playbook_runs pr
           SET status = 'failed', context = pr.context || $1::jsonb
           FROM playbooks p
           WHERE pr.playbook_id = p.id AND pr.id = $2
           RETURNING pr.*, p.name AS playbook_name`,
          [JSON.stringify({ _failure_reason: reason }), runId],
        );
        await execute("UPDATE threads SET status = 'in_review' WHERE id = $1", [threadId]);
        logger.error("playbook.run_failed", { run_id: runId, thread_id: threadId, reason });
        await sendAlert(workspaceId, "run_failed", { run_id: runId, thread_id: threadId, reason })
          .catch(() => {});
        if (updatedRun) {
          publish({ type: "run_updated", workspaceId, threadId, run: updatedRun });
        }
        const threadItem = await fetchThreadListItem(threadId, workspaceId);
        if (threadItem) {
          publish({
            type: "thread_updated",
            workspaceId,
            thread: threadItem as unknown as Record<string, unknown>,
          });
        }
        const context = updatedRun
          ? (typeof updatedRun.context === "string" ? JSON.parse(updatedRun.context) : updatedRun.context)
          : {};
        return { runId, status: "failed", currentStepId: updatedRun?.current_step_id ?? null, context };
      }
      ```
      Now rewrite `advanceRun`'s setup section (from `// Load the run` through the
      `storeProfile`/`variables` block, currently `~line 106-157`):
      ```ts
      export async function advanceRun(runId: number): Promise<RunResult> {
        // Load the run
        const run = await queryOne<PlaybookRun>(
          "SELECT * FROM playbook_runs WHERE id = $1",
          [runId],
        );
        if (!run) throw new Error(`Playbook run ${runId} not found`);

        // Everything else needed to execute a step can fail structurally - a
        // deleted thread, a disconnected Gmail account, a playbook removed out
        // from under a run. Contained here instead of propagating uncaught: the
        // run is marked failed with the real error, alerted, and the thread is
        // surfaced for review, instead of staying wedged in 'running' forever.
        let setup: RunSetup;
        try {
          setup = await loadRunSetup(run);
        } catch (err) {
          return await failRun(runId, run.thread_id, run.workspace_id, String(err));
        }
        const { steps } = setup;

        // Build context
        const variables: Record<string, unknown> = typeof run.context === "string"
          ? JSON.parse(run.context)
          : { ...run.context };

        let currentStepId = run.current_step_id;
        let status = run.status;
        // reset to running if this is a retry that was scheduled
        if (status === "retrying") status = "running";

        // If no current step, start at the first step
        if (!currentStepId && steps.length > 0) {
          currentStepId = steps[0].id;
        }
      ```
      Then inside the `while` loop, replace the inline `ctx` construction (currently
      `~line 227-240`, the `const ctx: RunContext = { run: { ...run, ... }, ... };` block) with:
      ```ts
          // Build the run context for this step
          const ctx: RunContext = buildRunContext(run, setup, variables, currentStepId, status);
      ```
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> deno test --allow-net --allow-env --allow-read services/playbook/executor_test.ts`
      Expect: `ok | 2 passed | 0 failed`.
- [ ] Also add the alert to the post-loop `failed` branch introduced in Task 5 Step 6 (this is
      the other half of "every structural failure gets an alert", not covered by the setup-only
      test above since that path returns early via `failRun`; this branch is for failures that
      happen mid-loop, e.g. a handler returning `{action:"fail"}` after exhausting retries).
      Replace:
      ```ts
        } else if (status === "failed") {
          // 'escalated' can no longer reach here - every escalation path returns
          // early via finalizeEscalation now (loop detection, the 50-cap, and the
          // escalate decision case above all do). Task 7 adds the run_failed alert
          // here.
          await execute("UPDATE threads SET status = 'in_review' WHERE id = $1", [run.thread_id]);
        }
      ```
      with:
      ```ts
        } else if (status === "failed") {
          await execute("UPDATE threads SET status = 'in_review' WHERE id = $1", [run.thread_id]);
          await sendAlert(run.workspace_id, "run_failed", {
            run_id: runId,
            thread_id: run.thread_id,
          }).catch(() => {});
        }
      ```
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> deno test --allow-net --allow-env --allow-read services/playbook/executor_test.ts`
      Expect: still `ok | 2 passed | 0 failed` (this branch has no dedicated new test - it is a
      one-line alert addition alongside an existing, already-covered status transition; the
      loop-detection and escalate-decision tests already exercise the surrounding function).
- [ ] `git add api/services/playbook/executor.ts api/services/playbook/executor_test.ts && git commit -m "Contain structural advanceRun setup failures instead of leaving runs wedged"`

#### Step 3: categorisation.ts - the swallowed startRun catch (TDD) [DB]

- [ ] Write the failing test. Create `api/services/categorisation_test.ts`:
      ```ts
      import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
      import { queryOne } from "../db/client.ts";
      import { handleStartRunFailure } from "./categorisation.ts";
      import { cleanupFixture, createTestFixture } from "./playbook/test-helpers.ts";

      Deno.test("handleStartRunFailure surfaces the thread for review [DB]", async () => {
        const fixture = await createTestFixture([]);
        try {
          await handleStartRunFailure(
            fixture.workspaceId,
            fixture.threadId,
            new Error("playbook vanished mid-route"),
          );

          const thread = await queryOne<{ status: string }>(
            "SELECT status FROM threads WHERE id = $1",
            [fixture.threadId],
          );
          assertEquals(thread!.status, "in_review");
        } finally {
          await cleanupFixture(fixture.workspaceId);
        }
      });
      ```
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> deno test --allow-net --allow-env --allow-read services/categorisation_test.ts`
      Expect failure: `handleStartRunFailure` is not exported from `categorisation.ts` yet
      (import error).
- [ ] Implement. In `api/services/categorisation.ts`, add `execute` to the db/client import and
      add the alerts import:
      ```ts
      import { execute, query, queryOne, transaction } from "../db/client.ts";
      import { AppError, Category, Message, OAuthToken, Setting, Thread } from "../types/index.ts";
      import { categoriseEmail } from "./ai.ts";
      import { applyLabel } from "./gmail.ts";
      import { evaluateRules } from "./sheet-rules.ts";
      import { startRun } from "./playbook/executor.ts";
      import type { Playbook, PlaybookRun } from "./playbook/types.ts";
      import { publish } from "./event-bus.ts";
      import { fetchThreadListItem } from "../db/queries.ts";
      import { sendAlert } from "./alerts.ts";
      ```
      Add the exported helper (place it near `cancelActiveRunsForRecategorisation`, at module
      scope so it can be tested directly):
      ```ts
      /**
       * startRun can still throw outside advanceRun's own containment (executor.ts's
       * loadRunSetup/failRun) - e.g. the playbook row disappearing between
       * validation and the INSERT here. Previously this was a bare console.error
       * with no DB write at all: the thread stayed wherever it was and nobody was
       * ever alerted. Exported for categorisation_test.ts.
       */
      export async function handleStartRunFailure(
        workspaceId: number,
        threadId: number,
        err: unknown,
      ): Promise<void> {
        await execute("UPDATE threads SET status = 'in_review' WHERE id = $1", [threadId]);
        await sendAlert(workspaceId, "run_failed", {
          thread_id: threadId,
          reason: `startRun failed: ${String(err)}`,
        }).catch(() => {});
      }
      ```
      Update the catch block inside `routeThreadToCategory`:
      ```ts
        try {
          await startRun(workspaceId, threadId, playbook.id);
        } catch (err) {
          console.error(`[categorisation] Playbook run failed for thread ${threadId}:`, err);
          await handleStartRunFailure(workspaceId, threadId, err);
        }
      ```
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> deno test --allow-net --allow-env --allow-read services/categorisation_test.ts`
      Expect: `ok | 1 passed | 0 failed`.
- [ ] `git add api/services/categorisation.ts api/services/categorisation_test.ts && git commit -m "Alert and surface the thread when startRun fails instead of swallowing the error"`

#### Step 4: failed_ingestions exhaustion alert - verify existing behavior, add regression coverage (TDD-adjacent) [DB]

Read carefully: `processFailedIngestions` in `retry_worker.ts` already does this correctly today
(insert defaults `attempt_count = 1`; the worker increments on each retry failure and alerts
`ingestion_failed_permanently` + sets `resolved = true` the moment `attempt_count` reaches 3).
There is no bug here to fix. Being honest about that instead of inventing a change: this step
adds the missing regression test only, and makes the function callable directly by tests (it
was module-private). Not a red/green cycle in the usual sense since the behavior already passes
- noting that explicitly per the "say so out loud when you skip TDD" rule, because there's
nothing to watch fail.

**Safety note for this test:** `processFailedIngestions` processes every unresolved row in the
whole table, not scoped to one workspace. Run this against a disposable/local test database only
- on a database with real pending `failed_ingestions` rows tied to live Gmail accounts, this test
would trigger real retry attempts against those accounts as a side effect.

- [ ] Add `export` to `processFailedIngestions` in `api/services/playbook/retry_worker.ts` (no
      other change - the function body is correct as-is):
      ```ts
      export async function processFailedIngestions(): Promise<void> {
      ```
- [ ] Append to `api/services/playbook/retry_worker_test.ts` (created in Task 5 Step 7):
      ```ts
      import { processFailedIngestions } from "./retry_worker.ts";
      // (add to the existing `import { processRetryRuns } from "./retry_worker.ts";` line
      // instead of a second import line: `import { processFailedIngestions, processRetryRuns } from "./retry_worker.ts";`)
      ```
      ```ts
      Deno.test("processFailedIngestions alerts exactly once when attempt_count exhausts at 3 [DB]", async () => {
        const fixture = await createTestFixture([], { withOAuthToken: false });
        const ingestion = await queryOne<{ id: number }>(
          `INSERT INTO failed_ingestions (workspace_id, gmail_message_id, gmail_thread_id, error, attempt_count)
           VALUES ($1, 'test-msg-1', 'test-thread-1', 'simulated failure', 2)
           RETURNING id`,
          [fixture.workspaceId],
        );
        try {
          await processFailedIngestions();

          const row = await queryOne<{ attempt_count: number; resolved: boolean; error: string }>(
            "SELECT attempt_count, resolved, error FROM failed_ingestions WHERE id = $1",
            [ingestion!.id],
          );
          assertEquals(row!.attempt_count, 3);
          assertEquals(row!.resolved, true);
          assertEquals(row!.error, "Gave up after 3 attempts");
        } finally {
          // failed_ingestions.workspace_id has no FK/cascade (migration 016) - clean
          // up explicitly, cleanupFixture's workspace delete won't reach this row.
          await execute("DELETE FROM failed_ingestions WHERE id = $1", [ingestion!.id]);
          await cleanupFixture(fixture.workspaceId);
        }
      });
      ```
      (`execute` needs adding to the existing `import { execute, queryOne } from "../../db/client.ts";`
      line at the top of `retry_worker_test.ts` if not already imported - it already is, from
      Task 5 Step 7's version of this file.)
- [ ] Run `cd api && DATABASE_URL=<your-local-test-db-url> deno test --allow-net --allow-env --allow-read services/playbook/retry_worker_test.ts`
      Expect: `ok | 2 passed | 0 failed` (both the Task 5 retry-runs-escalation test and this one).
- [ ] `git add api/services/playbook/retry_worker.ts api/services/playbook/retry_worker_test.ts && git commit -m "Export processFailedIngestions and add regression coverage for DLQ exhaustion alerting"`

Task 7 done.

---

### Task 8: Draft regeneration on stale approvals

**Files:**
- Create: `api/services/playbook/regenerate.ts`
- Create: `api/services/playbook/regenerate_test.ts`
- Modify: `api/routes/playbooks.ts` (import block; new route after `/runs/:runId/reject`, `~line 519`)
- Modify: `api/routes/playbooks_test.ts` (append one route-level test)
- Modify: `docs/TASK_LOG.md` (new top entry summarizing the reliability layer, Tasks 5-8)

**Interfaces:**
- Consumes: `loadRunSetup`, `buildRunContext`, `getRunSteps` (all from Task 7/existing
  `executor.ts`); Phase 1's final `api/services/playbook/composer.ts` contract:
  `composeAskDecision(inputs: ComposerInputs): Promise<{ decision: AskDecision; aiCall: AiCall }>`
  and `composeReplyBody(inputs: ComposerInputs & { referenceContext: Record<string, unknown> }): Promise<{ body: string; aiCall: AiCall }>`,
  where `AiCall = { model: string; prompt: string; response: string; tokens?: number }` - the
  exact element shape handlers already push into `StepResult.aiCalls` today. `AiCall` is
  imported as a type from `composer.ts`. Also consumes `isPresent` from Task 3's
  `context-utils.ts`, so `regeneratePendingDraft`'s reference-context filter uses the same
  presence rule `send_reply.ts` uses, instead of a bare `!= null` check.
- Produces: `POST /playbooks/runs/:runId/regenerate-draft -> { body: string }` (external contract
  unchanged); `regeneratePendingDraft(runId)`; `applyRegeneratedDraft(runId, threadId,
  workspaceId, body, aiCall)` (all in PRODUCED INTERFACES above). `applyRegeneratedDraft` now
  takes the composer's `aiCall` too and appends it onto the step execution's existing `ai_calls`
  audit trail (alongside the original draft's calls, not replacing them) - a human reviewing a
  regenerated draft can still see every AI attempt that produced it, not just the latest.

Same testing split as the rest of this plan: the DB-mutation half (`applyRegeneratedDraft`) and
the validation-guard half (`regeneratePendingDraft`'s early throws) are both real DB integration
tests with zero AI involved - `applyRegeneratedDraft`'s test passes a hand-built `AiCall` literal,
no composer call needed. The half that actually calls the composer (a real OpenAI call inside
`regeneratePendingDraft`'s two composer branches) is verified manually, for the same reason
Task 6's Gmail wiring is - no mocking layer exists for it.

#### Step 1: applyRegeneratedDraft - the DB mutation (TDD) [DB]

- [ ] Write the failing test. Create `api/services/playbook/regenerate_test.ts`:
      ```ts
      import { assertEquals, assertInstanceOf } from "https://deno.land/std@0.224.0/assert/mod.ts";
      import { execute, queryOne } from "../../db/client.ts";
      import { startRun } from "./executor.ts";
      import { AppError } from "../../types/index.ts";
      import type { AskCustomerStep, CompleteStep, PlaybookStep } from "./types.ts";
      import type { AiCall } from "./composer.ts";
      import { applyRegeneratedDraft, regeneratePendingDraft } from "./regenerate.ts";
      import { cleanupFixture, createTestFixture } from "./test-helpers.ts";

      Deno.test("applyRegeneratedDraft replaces the pending draft, records the aiCall, and clears _messages_since_draft [DB]", async () => {
        const steps: PlaybookStep[] = [
          {
            id: "ask_1",
            type: "ask_customer",
            message: "Please confirm your order number.",
            on_reply_goto: "complete_1",
            require_approval: true,
          } satisfies AskCustomerStep,
          { id: "complete_1", type: "complete" } satisfies CompleteStep,
        ];
        const fixture = await createTestFixture(steps);
        try {
          const started = await startRun(fixture.workspaceId, fixture.threadId, fixture.playbookId);
          assertEquals(started.status, "waiting_for_human");

          // Simulate gmail.ts (Task 6) having already attached a message since the draft.
          await execute(
            `UPDATE playbook_runs SET context = context || $1::jsonb WHERE id = $2`,
            [
              JSON.stringify({
                _messages_since_draft: [{ message_id: 1, received_at: "2026-07-20T00:00:00.000Z" }],
              }),
              started.runId,
            ],
          );

          // Hand-built AiCall - no composer/OpenAI call needed to test the DB mutation.
          const aiCall: AiCall = {
            model: "gpt-4o",
            prompt: "test prompt",
            response: "Updated draft body",
          };
          await applyRegeneratedDraft(
            started.runId,
            fixture.threadId,
            fixture.workspaceId,
            "Updated draft body",
            aiCall,
          );

          const run = await queryOne<{ context: Record<string, unknown> }>(
            "SELECT context FROM playbook_runs WHERE id = $1",
            [started.runId],
          );
          assertEquals(run!.context._messages_since_draft, undefined);

          const lastExec = await queryOne<{ output: { pending_send: string }; ai_calls: AiCall[] }>(
            `SELECT output, ai_calls FROM playbook_step_executions WHERE run_id = $1 AND step_id = 'ask_1' ORDER BY created_at DESC LIMIT 1`,
            [started.runId],
          );
          assertEquals(lastExec!.output.pending_send, "Updated draft body");
          // The legacy literal-message ask_customer path made no AI call originally
          // (ai_calls was NULL), so the regeneration's call is the only entry -
          // applyRegeneratedDraft appends onto whatever was there, it never wipes it.
          assertEquals(lastExec!.ai_calls, [aiCall]);
        } finally {
          await cleanupFixture(fixture.workspaceId);
        }
      });

      Deno.test("regeneratePendingDraft rejects when the run is not waiting_for_human [DB]", async () => {
        const steps: PlaybookStep[] = [{ id: "complete_1", type: "complete" } satisfies CompleteStep];
        const fixture = await createTestFixture(steps);
        try {
          const started = await startRun(fixture.workspaceId, fixture.threadId, fixture.playbookId);
          assertEquals(started.status, "complete");

          try {
            await regeneratePendingDraft(started.runId);
            throw new Error("expected regeneratePendingDraft to throw");
          } catch (err) {
            assertInstanceOf(err, AppError);
            assertEquals(err.statusCode, 409);
          }
        } finally {
          await cleanupFixture(fixture.workspaceId);
        }
      });
      ```
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> deno test --allow-net --allow-env --allow-read services/playbook/regenerate_test.ts`
      Expect failure: `regenerate.ts` does not exist yet (import error for both tests).
- [ ] Implement. Create `api/services/playbook/regenerate.ts`:
      ```ts
      /**
       * Draft regeneration for stale waiting_for_human approvals. When a customer
       * replies while a draft is pending approval, the run stays paused (design
       * doc 3.2) and the message is attached via _messages_since_draft
       * (gmail.ts). This module re-runs the same composer the original step
       * used, with the current transcript, and replaces the pending draft in
       * place - no new step execution, no status change, just a fresher draft
       * for the same approval.
       */
      import { execute, queryOne } from "../../db/client.ts";
      import { AppError } from "../../types/index.ts";
      import { publish } from "../event-bus.ts";
      import { buildRunContext, getRunSteps, loadRunSetup } from "./executor.ts";
      import { composeAskDecision, composeReplyBody } from "./composer.ts";
      import { isPresent } from "./context-utils.ts";
      import type { AiCall } from "./composer.ts";
      import type { Playbook, PlaybookRun, StepExecution } from "./types.ts";

      /**
       * Replaces the pending draft on the run's current step execution,
       * appends the regeneration's aiCall onto that step execution's existing
       * ai_calls audit trail (a human looking at the review queue can see
       * every draft attempt, not just the latest), and clears
       * _messages_since_draft - the human is looking at a fresh draft now, the
       * stale flag no longer applies. Separated from regeneratePendingDraft so
       * the DB mutation is testable without invoking the composer/AI call.
       */
      export async function applyRegeneratedDraft(
        runId: number,
        threadId: number,
        workspaceId: number,
        body: string,
        aiCall: AiCall,
      ): Promise<void> {
        const run = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [runId]);
        if (!run) throw new AppError(404, "Run not found");

        const currentContext = typeof run.context === "string"
          ? JSON.parse(run.context)
          : { ...run.context };
        delete currentContext._messages_since_draft;

        await execute(
          "UPDATE playbook_runs SET context = $1 WHERE id = $2",
          [JSON.stringify(currentContext), runId],
        );

        await execute(
          `UPDATE playbook_step_executions
           SET output = output || jsonb_build_object('pending_send', $1::text),
               ai_calls = COALESCE(ai_calls, '[]'::jsonb) || jsonb_build_array($2::jsonb)
           WHERE id = (
             SELECT id FROM playbook_step_executions
             WHERE run_id = $3 AND step_id = $4
             ORDER BY created_at DESC LIMIT 1
           )`,
          [body, JSON.stringify(aiCall), runId, run.current_step_id],
        );

        const updatedRun = await queryOne<PlaybookRun & { playbook_name: string }>(
          `SELECT pr.*, p.name AS playbook_name FROM playbook_runs pr JOIN playbooks p ON p.id = pr.playbook_id WHERE pr.id = $1`,
          [runId],
        );
        if (updatedRun) {
          publish({ type: "run_updated", workspaceId, threadId, run: updatedRun });
        }
      }

      /**
       * Re-runs the composer for a stale waiting_for_human draft and replaces
       * it. Only valid when the run is waiting_for_human with a genuine
       * pending send - the same validity check the approve/reject routes
       * already use. The route's external contract stays { body: string } -
       * the aiCall the composer returns is persisted as a side effect via
       * applyRegeneratedDraft, not handed back to the caller.
       */
      export async function regeneratePendingDraft(runId: number): Promise<{ body: string }> {
        const run = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [runId]);
        if (!run) throw new AppError(404, "Run not found");
        if (run.status !== "waiting_for_human") {
          throw new AppError(409, `Run is not waiting_for_human (status: ${run.status})`);
        }

        const playbook = await queryOne<Playbook>(
          "SELECT * FROM playbooks WHERE id = $1",
          [run.playbook_id],
        );
        if (!playbook) throw new AppError(404, "Playbook not found");

        const steps = getRunSteps(run, playbook);
        const currentStep = steps.find((s) => s.id === run.current_step_id);
        if (
          !currentStep ||
          (currentStep.type !== "ask_customer" && currentStep.type !== "send_reply")
        ) {
          throw new AppError(409, "Run has no pending send to regenerate");
        }

        const lastExec = await queryOne<StepExecution>(
          `SELECT * FROM playbook_step_executions WHERE run_id = $1 AND step_id = $2 ORDER BY created_at DESC LIMIT 1`,
          [runId, currentStep.id],
        );
        const output = typeof lastExec?.output === "string"
          ? JSON.parse(lastExec.output as string)
          : (lastExec?.output as Record<string, unknown> | null);
        if (output?.action !== "pending_approval" || typeof output.pending_send !== "string") {
          throw new AppError(409, "Run has no pending send to regenerate");
        }
        const pendingSend = output.pending_send as string; // guarded above: typeof === "string"

        const setup = await loadRunSetup(run);
        const variables = typeof run.context === "string" ? JSON.parse(run.context) : { ...run.context };
        const ctx = buildRunContext(run, setup, variables, run.current_step_id, run.status);

        const voice = currentStep.voice_hint ?? (playbook.writing_style || "friendly and professional");

        let body: string;
        let aiCall: AiCall;
        if (currentStep.type === "send_reply") {
          const referenceContext: Record<string, unknown> = {};
          for (const key of currentStep.reference_context ?? []) {
            if (isPresent(variables[key])) referenceContext[key] = variables[key];
          }
          const composed = await composeReplyBody({
            ctx,
            goal: currentStep.goal ??
              "Write a helpful and contextual reply to close out this interaction",
            voice,
            requiredContext: [],
            priorSent: [],
            referenceContext,
          });
          body = composed.body;
          aiCall = composed.aiCall;
        } else {
          const composed = await composeAskDecision({
            ctx,
            goal: currentStep.goal ?? "",
            voice,
            requiredContext: currentStep.required_context ?? [],
            priorSent: [pendingSend],
          });
          if (composed.decision.action !== "ask" || !composed.decision.message) {
            throw new AppError(
              409,
              `Composer could not draft a message from the current transcript (AI now recommends: ${composed.decision.action}). Handle this run manually instead of regenerating.`,
            );
          }
          body = composed.decision.message;
          aiCall = composed.aiCall;
        }

        await applyRegeneratedDraft(runId, run.thread_id, run.workspace_id, body, aiCall);
        return { body };
      }
      ```
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> deno test --allow-net --allow-env --allow-read services/playbook/regenerate_test.ts`
      Expect: `ok | 2 passed | 0 failed`.
- [ ] `git add api/services/playbook/regenerate.ts api/services/playbook/regenerate_test.ts && git commit -m "Add regeneratePendingDraft and applyRegeneratedDraft for stale approvals"`

#### Step 2: Route (TDD) [DB+AUTH]

- [ ] Write the failing test. Append to `api/routes/playbooks_test.ts` (created in Task 5 Step 8):
      ```ts
      Deno.test("POST /runs/:id/regenerate-draft rejects when the run is not waiting_for_human [DB+AUTH]", async () => {
        const steps: PlaybookStep[] = [{ id: "complete_1", type: "complete" } satisfies CompleteStep];
        const fixture = await createTestFixture(steps);
        try {
          const started = await startRun(fixture.workspaceId, fixture.threadId, fixture.playbookId);
          assertEquals(started.status, "complete");

          const res = await authedRequest(`/runs/${started.runId}/regenerate-draft`, { method: "POST" });
          assertEquals(res.status, 409);
        } finally {
          await cleanupFixture(fixture.workspaceId);
        }
      });
      ```
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> API_SECRET=test-secret deno test --allow-net --allow-env --allow-read routes/playbooks_test.ts`
      Expect failure: `404 Not Found` (route doesn't exist yet), not `409`.
- [ ] Implement. In `api/routes/playbooks.ts`, add one new import line (the `executor.ts` import
      already includes `finalizeEscalation` from Task 5 Step 8 - this only adds `regenerate.ts`):
      ```ts
      import { regeneratePendingDraft } from "../services/playbook/regenerate.ts";
      ```
      Add the route directly after `/runs/:runId/reject` (`~line 519`, right before the
      `/runs/:runId/cancel` route):
      ```ts
      // POST /playbooks/runs/:runId/regenerate-draft
      playbooksRouter.post("/runs/:runId/regenerate-draft", async (c) => {
        const runId = parseInt(c.req.param("runId"));
        if (isNaN(runId)) throw new AppError(400, "Invalid run ID");
        const result = await regeneratePendingDraft(runId);
        return c.json(result);
      });
      ```
- [ ] Run `cd api && DATABASE_URL=<your-local-db-url> API_SECRET=test-secret deno test --allow-net --allow-env --allow-read routes/playbooks_test.ts`
      Expect: `ok | 3 passed | 0 failed` (the two Task 5 tests plus this one).
- [ ] `git add api/routes/playbooks.ts api/routes/playbooks_test.ts && git commit -m "Add POST /playbooks/runs/:id/regenerate-draft route"`

#### Manual verification (required before calling Task 8 done - the AI-calling path has no automated test)

1. Get a run into `waiting_for_human` with a genuine pending send (an `ask_customer` or
   `send_reply` step with `require_approval: true` or a `draft_only` playbook).
2. Send a follow-up email into the thread (per Task 6, this appends to `_messages_since_draft`
   without disturbing the run). Confirm via
   `SELECT context->'_messages_since_draft' FROM playbook_runs WHERE id = <run_id>;`
3. `curl -X POST http://localhost:8000/playbooks/runs/<run_id>/regenerate-draft -H "Authorization: Bearer $API_SECRET"`
   Expect `200` with `{"body": "..."}` - a message that references the follow-up email's content.
4. Re-check the DB:
   `SELECT context->'_messages_since_draft' FROM playbook_runs WHERE id = <run_id>;` - expect
   `NULL` (cleared).
   `SELECT output->>'pending_send' FROM playbook_step_executions WHERE run_id = <run_id> ORDER BY created_at DESC LIMIT 1;`
   - expect the new body, matching the curl response.
5. Confirm via the dashboard (or `GET /playbooks/runs/<run_id>`) that the run is still
   `waiting_for_human` on the same step - regeneration replaces the draft, it does not advance
   or re-pause the run.

#### Step 3: Add the reliability layer's top entry to `docs/TASK_LOG.md`

- [ ] Insert this entry immediately above the current top entry (write this verbatim; if a later
      task's entry has already been inserted first, insert this one directly above that entry,
      keeping newest-first order):

```markdown
## 2026-07-20 - Reliability layer: escalation taxonomy, inbound-during-run survival, wedge-proofing

**Problem:** Runs could wedge in `running` forever on a structural failure (missing thread, no
OAuth token, a deleted playbook) with nothing visible to a human. Escalation reasons were
frequently wrong (a hardcoded step string, not the real cause), and the two reject flows
(pending-send vs `manual_approval`) didn't converge, so one of them recorded no reason, never
moved the thread to `in_review`, and never alerted. An inbound customer message during an active
run (`waiting_for_human`, `waiting_to_send`) would destroy that run and start a fresh one,
silently discarding a pending draft or a customer's reply. Timeout and retry workers hand-rolled
their own "mark escalated" logic and never published `run_updated` over SSE.

**Changes made:**
- `api/services/playbook/executor.ts`: added `finalizeEscalation` as the single code path that
  ever writes `status = 'escalated'` (real reason recorded, thread moved to `in_review`, alert
  fired, SSE published) and `failRun`/`loadRunSetup`/`buildRunContext` as the equivalent
  containment for genuine structural failures (`status = 'failed'`), so `advanceRun` never leaves
  a run wedged with nothing surfaced. Every escalation path - loop detection, the 50-step cap,
  the new `escalate` step decision, both human-reject flows in `routes/playbooks.ts`, and the
  timeout/retry workers - now goes through one of these two functions.
- `api/services/playbook/handlers/escalate.ts`, `ask_customer.ts`, `evaluate.ts`: escalation
  reason precedence is now `_rejection_source` (explicit human rejection) over
  `_escalation_reason` (a dynamic reason an upstream step already computed) over the step's own
  static config reason, so "Could not find order in sheet" no longer shows up when the real cause
  was something else. `evaluate.ts`'s AI escalate path no longer routes through
  `if_escalate_goto` (a step with a hardcoded reason) - it returns the `escalate` decision
  directly with the AI's real stated reason.
- `api/services/gmail.ts`: `resolveInboundRunAction` maps a thread's active run status to what an
  inbound message should do to it - resume a `waiting_for_customer` run, attach the message to a
  `waiting_for_human` run's context (`_messages_since_draft`) instead of cancelling it, requeue a
  `waiting_to_send` run's delayed send, or leave a `running`/`retrying` run alone. A new message
  never destroys an active run; only a thread with no active (or a terminal) run falls through to
  recategorisation.
- `api/services/categorisation.ts`: `handleStartRunFailure` surfaces the thread for review and
  alerts when `startRun` throws, instead of a bare `console.error` that left the thread wherever
  it was with nobody notified.
- `api/services/alerts.ts`: added the `run_failed` alert event alongside the existing
  `run_escalated`.
- `api/services/playbook/regenerate.ts`: `regeneratePendingDraft`/`applyRegeneratedDraft` let a
  stale `waiting_for_human` draft (one where the customer replied again before it was approved)
  be re-composed against the current transcript and replaced in place, clearing
  `_messages_since_draft` and appending the regeneration's AI call onto the step execution's
  existing `ai_calls` audit trail rather than replacing it.

**Validation:**
- `deno test --allow-net --allow-env --allow-read` in `api/`: all tests pass, including
  `escalate_test.ts`, `ask_customer_test.ts`, `evaluate_test.ts`, `executor_test.ts`,
  `timeout_worker_test.ts`, `retry_worker_test.ts`, `playbooks_test.ts`, `gmail_test.ts`,
  `categorisation_test.ts`, and `regenerate_test.ts` (run against a real local Postgres per this
  phase's `[DB]`/`[DB+AUTH]` convention).
- `deno check main.ts` passes.
- Manual verification (Task 6 and Task 8's manual-verification sections above): confirmed an
  inbound message during `waiting_for_human` and `waiting_to_send` survives without cancelling
  the run, and that `regenerate-draft` replaces a stale pending send without advancing or
  re-pausing it.
```

- [ ] `git add docs/TASK_LOG.md && git commit -m "Record the reliability layer in TASK_LOG"`

Task 8 done. All four tasks (5-8) complete.

---

---

# E-com Autopilot Rethink - Phase 3 (Tasks 9-13) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement section 3.3 (product layer) of `docs/superpowers/specs/2026-07-20-email-autopilot-rethink-design.md`: make `/review` the discoverable home for manual reply work, retire the legacy `drafts` table flow from the UI, make outbound mail look human (display name + signature + attachment markers), add the trust-ramp graduation mechanism, and true up the docs.

**Architecture:** No new subsystems. This phase wires existing primitives (playbook pending-sends, the event bus, SSE, settings) into product-facing surfaces, and adds one new service (`trust-ramp.ts`) that reads/writes two existing columns (`playbooks.approval_streak`, `playbooks.auto_send_streak_target`, migration 028, already applied by an earlier phase).

**Tech Stack:** Deno + Hono (backend), SvelteKit 5 with runes (frontend), Postgres 16, no new dependencies.

## Global Constraints

- SvelteKit 5 runes ONLY (`$state`, `$derived`, `$effect`, `$props`, `$bindable`). No `let x = ...` for reactive state, no `$:`, no `export let`.
- All frontend API calls go through `frontend/src/lib/api.ts`. No direct `fetch` in components.
- CSS variables from `+layout.svelte`. Component-scoped `<style>` blocks. No Tailwind.
- Every data-fetching view has loading/error/content states.
- Backend routes are thin; logic lives in services. Throw `AppError(statusCode, message, detail?)` for known errors (confirmed signature: statusCode first, per `api/types/index.ts:280-289`).
- All multi-statement DB writes use `transaction()` from `api/db/client.ts`. Single-statement writes may use `execute()`/`queryOne()` directly (matches existing convention, e.g. `cancelStaleWaitingRun` in `api/routes/playbooks.ts`).
- Every query on workspace-owned data filters by `workspace_id`.
- Comments explain WHY, not WHAT.
- No em dashes anywhere, in code, comments, docs, commit messages, or UI copy. Use a comma, colon, or rewrite the sentence.
- Commit messages: short imperative, no attribution footers.
- Frontend has no unit-test harness (no vitest, no `*.test.ts` found). Frontend verification steps use Playwright MCP (`mcp__playwright__browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`) with exact elements/text to check. Backend verification uses `deno test` (repo test command, from `api/deno.json`: `deno test --allow-net --allow-env --allow-read`).

---

## PRODUCED INTERFACES

Backend (new/changed exports):

- `recordApprovalOutcome(runId: number, outcome: "approved_clean" | "approved_edited" | "rejected"): Promise<{ graduated: boolean }>`: `api/services/playbook/trust-ramp.ts`
- `revertToDraftOnly(playbookId: number): Promise<Playbook | null>`: `api/services/playbook/trust-ramp.ts`
- `computeStreakTransition(state: StreakState, outcome: ApprovalOutcome): StreakTransition`: pure helper, `api/services/playbook/trust-ramp.ts` (same pattern as `resolveTriageDecision` in `handlers/triage.ts`)
- `POST /playbooks/:id/revert-to-draft` -> `{ playbook: Playbook }` (new route)
- `GET /playbooks/runs` now also selects `approval_streak`, `auto_send_streak_target` per run (joined from the run's playbook)
- **409 conflict contract (already implemented, confirmed by reading `api/routes/playbooks.ts`):** `POST /playbooks/runs/:id/approve` and `POST /playbooks/runs/:id/reject` throw `AppError(409, "Run is not waiting_for_human (status: <status>)")` when the run is no longer `waiting_for_human`. Task 9 only adds frontend handling for this existing contract.
- `BusEvent` gains: `{ type: "playbook_graduated"; workspaceId: number; playbook: { id: number; name: string; category_id: number | null; reply_mode: string } }`: `api/services/event-bus.ts`
- `AlertEvent` gains: `"playbook_graduated"`: `api/services/alerts.ts`
- `formatFromHeader(storeName: string | null, email: string): string`: `api/services/gmail.ts`
- `appendSignature(body: string, senderName: string | null): string`: `api/services/gmail.ts` (idempotent: will not duplicate a signature block already present)
- `appendAttachmentMarkers(text: string, filenames: string[]): string`: `api/services/gmail.ts`
- `resolveSimulatedFollowUp(askStep: AskCustomerStep, currentEmailContent: string, followUpMessage: string | undefined, followUpConsumed: boolean): { consumed: false } | { consumed: true; nextEmailContent: string; nextStepId: string }`: `api/services/playbook/dry-run.ts`
- `dryRunPlaybook(playbookId: number, emailContent: string, workspaceId: number, followUpMessage?: string): Promise<DryRunResult>`: signature gains a 4th optional param
- `parsePlaybook` / `parsePlaybookStep` in `api/services/playbook/parser.ts` now call `getModel(workspaceId)` instead of hardcoding `"gpt-4o"` (signatures unchanged)

Frontend (new/changed exports in `frontend/src/lib/api.ts`):

- `playbooksApi.regenerateDraft(runId: number): Promise<{ body: string }>`
- `playbooksApi.revertToDraft(id: number): Promise<{ playbook: Playbook }>`
- `playbooksApi.dryRun(id: number, emailContent: string, workspaceId?: number, followUpMessage?: string): Promise<DryRunResult>` (4th param added, backward compatible)
- `Playbook` interface gains `approval_streak: number; auto_send_streak_target: number;`
- `PlaybookRun` interface gains `approval_streak?: number; auto_send_streak_target?: number;`

Consumed from earlier phases (treated as existing, not built here): `POST /playbooks/runs/:id/regenerate-draft` -> `{ body: string }`; run context key `_messages_since_draft: Array<{ message_id: number | null; received_at: string }>`; migration 028 (`playbooks.auto_send_streak_target INT DEFAULT 10`, `playbooks.approval_streak INT DEFAULT 0`); `api/services/playbook/composer.ts`; `api/services/playbook/brief.ts`.

---

### Task 9: Review queue as home

**Files:**
- Modify: `frontend/src/routes/+layout.svelte` (nav links array, badge condition)
- Modify: `frontend/src/lib/api.ts` (add `playbooksApi.regenerateDraft`, import `ApiRequestError` is already exported there)
- Modify: `frontend/src/routes/review/+page.svelte` (SSE subscription, 409 handling, stale-draft notice)
- Modify: `frontend/src/lib/components/ManualActionBanner.svelte` (stale-draft notice)
- Modify: `frontend/src/routes/system/+page.svelte` (quick links to `/sheet-updates`, `/sheet-rules`)
- Test: Playwright MCP verification (no frontend unit-test harness exists)

**Interfaces:**
- Consumes: `attentionCountStore` (derived store, `frontend/src/lib/stores.ts:103-114`, unchanged); existing 409 contract on `POST /playbooks/runs/:id/approve` and `/reject` (`api/routes/playbooks.ts:253-254`, `:431-432`); `run.context._messages_since_draft` (earlier phase); `openSSE(path, params)` from `frontend/src/lib/sse.ts` (unchanged); `POST /playbooks/runs/:id/regenerate-draft` -> `{ body: string }` (earlier phase, not built here).
- Produces: `playbooksApi.regenerateDraft(runId: number): Promise<{ body: string }>` in `frontend/src/lib/api.ts`.

- [ ] **Step 1: Confirm the 409 conflict guard already exists server-side**

Run: `grep -n "AppError(409" api/routes/playbooks.ts`

Expected output (two matches, one per route):
```
254:    throw new AppError(409, `Run is not waiting_for_human (status: ${run.status})`);
432:    throw new AppError(409, `Run is not waiting_for_human (status: ${run.status})`);
```

This confirms Task 9 needs no backend change for the conflict guard itself, only frontend handling.

- [ ] **Step 2: Add the "Review" nav link with badge in `+layout.svelte`**

In `frontend/src/routes/+layout.svelte`, change the icon import (currently `import { Inbox, BookOpen, Settings, Plane, Menu, X } from '@lucide/svelte';`) to:

```svelte
import { Inbox, CheckCircle, BookOpen, Settings, Plane, Menu, X } from '@lucide/svelte';
```

Change the `navLinks` array from:

```js
const navLinks = [
	{ href: '/', label: 'Inbox', icon: Inbox },
	{ href: '/playbooks', label: 'Playbooks', icon: BookOpen },
	{ href: '/settings', label: 'Settings', icon: Settings },
];
```

to:

```js
const navLinks = [
	{ href: '/', label: 'Inbox', icon: Inbox },
	{ href: '/review', label: 'Review', icon: CheckCircle },
	{ href: '/playbooks', label: 'Playbooks', icon: BookOpen },
	{ href: '/settings', label: 'Settings', icon: Settings },
];
```

Change the badge condition inside the `{#each navLinks ...}` block from:

```svelte
{#if href === '/' && attentionCount > 0}
	<span class="nav-badge">{attentionCount}</span>
{/if}
```

to:

```svelte
{#if (href === '/' || href === '/review') && attentionCount > 0}
	<span class="nav-badge">{attentionCount}</span>
{/if}
```

`CheckCircle` is already imported and verified to exist in this exact `@lucide/svelte` version (used in `frontend/src/routes/review/+page.svelte` and `frontend/src/routes/threads/[id]/+page.svelte`), so there is no icon-name risk.

- [ ] **Step 3: Playwright verify the nav change**

Use `mcp__playwright__browser_navigate` to open the running dev app at `/`. Use `mcp__playwright__browser_snapshot` and confirm the sidebar shows, in order: "Inbox", "Review", "Playbooks", "Settings". Use `mcp__playwright__browser_click` on the "Review" link, then `browser_snapshot` again and confirm the URL is `/review` and the "Review" nav item has the `active` visual state (bold, primary color, left border, matching the existing `.nav-link.active` CSS already in the file).

- [ ] **Step 4: Add `regenerateDraft` to `playbooksApi` in `frontend/src/lib/api.ts`**

Add this method inside the `playbooksApi` object, near `approveRun`/`rejectRun`:

```ts
	regenerateDraft(runId: number) {
		return request<{ body: string }>(`/playbooks/runs/${runId}/regenerate-draft`, {
			method: 'POST'
		});
	},
```

- [ ] **Step 5: Run the frontend typecheck**

Run: `cd frontend && npm run check`
Expected: `0 errors` (existing warnings, if any, are unrelated and unchanged).

- [ ] **Step 6: Add SSE subscription and 409 handling to `frontend/src/routes/review/+page.svelte`**

Change the top imports from:

```svelte
  import { threadsApi, playbooksApi } from "$lib/api";
  import type { ThreadListItem, ThreadDetail, Draft, PlaybookRun } from "$lib/api";
  import { CheckCircle } from '@lucide/svelte';
```

to:

```svelte
  import { threadsApi, playbooksApi, ApiRequestError } from "$lib/api";
  import type { ThreadListItem, ThreadDetail, Draft, PlaybookRun } from "$lib/api";
  import { CheckCircle, AlertTriangle } from '@lucide/svelte';
  import { openSSE } from "$lib/sse";
```

Add `onMount` is already imported; add `onDestroy` is not needed since the effect below returns its own cleanup. After the existing `onMount(...)` block, add:

```svelte
  $effect(() => {
    let connectionCount = 0;
    const es = openSSE('workspace', { workspace_id: 1 });

    es.addEventListener('open', () => {
      connectionCount++;
      // A reconnect after the first connection means we missed events while
      // disconnected, so do a full reload rather than trust partial state.
      if (connectionCount > 1) load();
    });

    es.addEventListener('thread_updated', () => {
      load();
    });

    es.addEventListener('run_updated', () => {
      load();
    });

    return () => es.close();
  });
```

Change `approveRun` from:

```ts
  async function approveRun(runId: number, captureInput: boolean) {
    runActioning = runId;
    error = null;
    try {
      const input = captureInput ? runInputs[runId] : undefined;
      // Pass edited reply body for pending_send approvals
      const body = runBodies[runId];
      await playbooksApi.approveRun(runId, input, body);
      successMessage = "Approved - playbook resumed.";
      setTimeout(() => { successMessage = null; }, 3000);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to approve";
    } finally {
      runActioning = null;
    }
  }
```

to:

```ts
  async function approveRun(runId: number, captureInput: boolean) {
    runActioning = runId;
    error = null;
    try {
      const input = captureInput ? runInputs[runId] : undefined;
      // Pass edited reply body for pending_send approvals
      const body = runBodies[runId];
      await playbooksApi.approveRun(runId, input, body);
      successMessage = "Approved - playbook resumed.";
      setTimeout(() => { successMessage = null; }, 3000);
      await load();
    } catch (e) {
      if (e instanceof ApiRequestError && e.error.status === 409) {
        error = "This action was already handled elsewhere.";
        await load();
      } else {
        error = e instanceof Error ? e.message : "Failed to approve";
      }
    } finally {
      runActioning = null;
    }
  }
```

Change `rejectRun` from:

```ts
  async function rejectRun(runId: number) {
    runActioning = runId;
    error = null;
    try {
      await playbooksApi.rejectRun(runId);
      successMessage = "Rejected - run escalated.";
      setTimeout(() => { successMessage = null; }, 3000);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to reject";
    } finally {
      runActioning = null;
    }
  }
```

to:

```ts
  async function rejectRun(runId: number) {
    runActioning = runId;
    error = null;
    try {
      await playbooksApi.rejectRun(runId);
      successMessage = "Rejected - run escalated.";
      setTimeout(() => { successMessage = null; }, 3000);
      await load();
    } catch (e) {
      if (e instanceof ApiRequestError && e.error.status === 409) {
        error = "This action was already handled elsewhere.";
        await load();
      } else {
        error = e instanceof Error ? e.message : "Failed to reject";
      }
    } finally {
      runActioning = null;
    }
  }
```

- [ ] **Step 7: Add the "customer replied since this draft" notice to the pending-send card**

Add these two helpers right after the `runsByReason` derived block:

```ts
  let regeneratingRunId = $state<number | null>(null);

  function messagesSinceDraft(run: PlaybookRun): Array<{ message_id: number | null; received_at: string }> {
    const raw = run.context?._messages_since_draft;
    return Array.isArray(raw) ? (raw as Array<{ message_id: number | null; received_at: string }>) : [];
  }

  async function regenerateDraft(runId: number) {
    regeneratingRunId = runId;
    error = null;
    try {
      const res = await playbooksApi.regenerateDraft(runId);
      runBodies[runId] = res.body;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to regenerate draft";
    } finally {
      regeneratingRunId = null;
    }
  }
```

Inside the `{#if run.step_pending_send}` block, immediately after the closing `</div>` of `pending-send-header` and before the `<textarea>`, add:

```svelte
                {#if messagesSinceDraft(run).length > 0}
                  <div class="stale-draft-notice">
                    <AlertTriangle size={14} />
                    <span>Customer replied since this draft was written.</span>
                    <button
                      class="btn btn-ghost btn-sm"
                      onclick={() => regenerateDraft(run.id)}
                      disabled={regeneratingRunId === run.id}
                    >
                      {regeneratingRunId === run.id ? "Regenerating…" : "Regenerate draft"}
                    </button>
                  </div>
                {/if}
```

Note: the ellipsis character `…` above is a single Unicode ellipsis glyph (U+2026), not two or three periods and not an em dash; it already appears elsewhere in this same file (e.g. `runActioning === run.id ? "…" : "Approve"`), so it is consistent with existing repo style and is not a banned dash character.

Add this CSS inside the `<style>` block, near `.pending-send-area`:

```css
  .stale-draft-notice {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: rgba(245 158 11 / 0.1);
    border: 1px solid rgba(245 158 11 / 0.35);
    border-radius: var(--radius);
    color: var(--color-warning);
    font-size: 12px;
    flex-wrap: wrap;
  }

  .stale-draft-notice span {
    flex: 1;
    min-width: 160px;
  }
```

- [ ] **Step 8: Add the same notice to `ManualActionBanner.svelte`**

Change the imports from:

```svelte
  import { playbooksApi } from "$lib/api";
  import type { PlaybookRun } from "$lib/api";
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { untrack } from "svelte";
  import { Bell, Mail, ExternalLink } from '@lucide/svelte';
```

to:

```svelte
  import { playbooksApi } from "$lib/api";
  import type { PlaybookRun } from "$lib/api";
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { untrack } from "svelte";
  import { Bell, Mail, ExternalLink, AlertTriangle } from '@lucide/svelte';
```

After the `canApprove` derived block, add:

```ts
  let messagesSinceDraft = $derived.by(() => {
    const raw = run.context?._messages_since_draft;
    return Array.isArray(raw) ? (raw as Array<{ message_id: number | null; received_at: string }>) : [];
  });
  let regenerating = $state(false);

  async function regenerateDraft() {
    regenerating = true;
    error = null;
    try {
      const res = await playbooksApi.regenerateDraft(run.id);
      draftBody = res.body;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to regenerate draft";
    } finally {
      regenerating = false;
    }
  }
```

Inside the `{#if isPendingSend}` block, right after `<p class="banner-reason">Edit the AI-drafted reply if needed, then send.</p>`, add:

```svelte
    {#if messagesSinceDraft.length > 0}
      <div class="stale-draft-notice">
        <AlertTriangle size={14} />
        <span>Customer replied since this draft was written.</span>
        <button class="regen-btn" onclick={regenerateDraft} disabled={regenerating || submitting}>
          {regenerating ? "Regenerating…" : "Regenerate draft"}
        </button>
      </div>
    {/if}
```

Add this CSS inside the `<style>` block, near `.banner-reason`:

```css
  .stale-draft-notice {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.875rem;
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.35);
    border-radius: calc(var(--radius, 8px) - 2px);
    color: var(--color-warning, #f59e0b);
    font-size: 0.8125rem;
    flex-wrap: wrap;
  }

  .stale-draft-notice span {
    flex: 1;
    min-width: 10rem;
  }

  .regen-btn {
    background: transparent;
    border: 1px solid rgba(245, 158, 11, 0.5);
    color: var(--color-warning, #f59e0b);
    padding: 0.3rem 0.75rem;
    border-radius: calc(var(--radius, 8px) - 2px);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .regen-btn:hover:not(:disabled) {
    background: rgba(245, 158, 11, 0.15);
  }

  .regen-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
```

- [ ] **Step 9: Add quick links to `/sheet-updates` and `/sheet-rules` on `/system`**

In `frontend/src/routes/system/+page.svelte`, immediately after the `</div>` that closes `.header` (before `{#if error}`), add:

```svelte
  <div class="quick-links">
    <a href="/sheet-updates">Sheet Updates</a>
    <a href="/sheet-rules">Sheet Rules</a>
    <a href="/system/failed-ingestions">Failed Ingestions</a>
  </div>
```

Add this CSS inside the `<style>` block, near `.header`:

```css
  .quick-links { display: flex; gap: 1rem; margin-bottom: 1.25rem; }
  .quick-links a { font-size: 0.85rem; color: var(--color-primary); text-decoration: none; }
  .quick-links a:hover { text-decoration: underline; }
```

- [ ] **Step 10: Run the frontend typecheck**

Run: `cd frontend && npm run check`
Expected: `0 errors`.

- [ ] **Step 11: Playwright verify the review queue flow**

Use `mcp__playwright__browser_navigate` to `/review`. Use `mcp__playwright__browser_snapshot` and confirm the page renders without an error banner (loading/error/content states already exist in this file). If there is a pending playbook approval in the local dataset with a non-empty `_messages_since_draft` context, confirm the "Customer replied since this draft was written." notice and "Regenerate draft" button are visible; click it and confirm the textarea content changes and no error banner appears. Then navigate to `/system` and use `browser_snapshot` to confirm "Sheet Updates" and "Sheet Rules" links are present and clicking each navigates to `/sheet-updates` and `/sheet-rules` respectively without a 404.

- [ ] **Step 12: Commit**

```bash
git add frontend/src/routes/+layout.svelte frontend/src/lib/api.ts frontend/src/routes/review/+page.svelte frontend/src/lib/components/ManualActionBanner.svelte frontend/src/routes/system/+page.svelte
git commit -m "Make review queue the discoverable manual-reply home"
```

---

### Task 10: One draft model

**Files:**
- Modify: `frontend/src/routes/threads/[id]/+page.svelte` (remove legacy drafts rendering)
- Modify: `frontend/src/routes/review/+page.svelte` (remove legacy drafts rendering)
- Modify: `frontend/src/lib/api.ts` (remove `threadsApi.updateDraftStatus`)
- Modify: `api/routes/threads.ts` (drafts sub-routes return 410 Gone; prune now-unused imports)
- Modify: `api/services/categorisation.ts` (remove `skipIfPendingDraft`)
- Test: Playwright MCP verification, `deno check`/`deno test`

**Interfaces:**
- Consumes: none new.
- Produces: `GET /threads/:id/drafts` and `PATCH /threads/:id/drafts/:draftId` now respond `410 Gone`. `ThreadDetail.drafts` (the field, not the endpoints) is unchanged and still returned by `GET /threads/:id` since the table is not dropped.

Before touching prod: this task does not drop the `drafts` table. Before it is ever dropped in a future migration, run this exact query against production and confirm the count is 0:

```sql
SELECT count(*) FROM drafts WHERE status = 'pending';
```

- [ ] **Step 1: Confirm no test currently covers the legacy drafts endpoints or `skipIfPendingDraft`**

Run: `grep -rln "drafts/\|updateDraftStatus\|skipIfPendingDraft" api --include="*_test.ts"`
Expected: no output (already confirmed empty). This is a safe removal with no test to update first; the verification step is `deno check` plus the existing suite staying green, not a new failing test, since nothing here is new behavior to drive with TDD, it is dead-flow retirement.

- [ ] **Step 2: Remove legacy drafts rendering from `frontend/src/routes/threads/[id]/+page.svelte`**

Change the top type import from:

```svelte
  import type { ThreadDetail, Draft, Message, PlaybookRun, StepExecution, Workspace } from "$lib/api";
```

to:

```svelte
  import type { ThreadDetail, Message, PlaybookRun, StepExecution, Workspace } from "$lib/api";
```

Remove this function entirely:

```ts
  async function handleDraftAction(draftId: number, status: Draft["status"]) {
    try {
      await threadsApi.updateDraftStatus(threadId, draftId, status);
      success = `Draft ${status}.`;
      setTimeout(() => {
        success = null;
      }, 3000);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to update draft";
    }
  }
```

Change the markup block:

```svelte
      {#if thread.drafts.length > 0}
        <div class="drafts-section">
          <h3>Drafts ({thread.drafts.length})</h3>
          {#each thread.drafts as draft (draft.id)}
            <div class="draft card">
              <div class="draft-header">
                <span class="draft-status draft-{draft.status}">{draft.status}</span>
                <span class="date">{new Date(draft.created_at).toLocaleString()}</span>
              </div>
              <pre class="draft-body">{draft.body}</pre>
              {#if draft.status === "pending"}
                <div class="draft-actions">
                  <button class="btn btn-primary" onclick={() => handleDraftAction(draft.id, "approved")}>Approve & Send</button>
                  <button class="btn btn-ghost" onclick={() => handleDraftAction(draft.id, "rejected")}>Reject</button>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <ManualReplyPanel {threadId} onSent={load} />
```

to:

```svelte
      <ManualReplyPanel {threadId} onSent={load} />
```

Remove this whole CSS block from the `<style>` section (it is entirely dead once the markup above is gone):

```css
  /* ─── Drafts ─── */
  .drafts-section h3 { font-size: 14px; font-weight: 700; margin-bottom: 10px; }

  .draft-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }

  .draft-status {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .draft-pending { background: rgba(245 158 11 / 0.15); color: var(--color-warning); }
  .draft-approved { background: rgba(16 185 129 / 0.15); color: var(--color-success); }
  .draft-rejected { background: rgba(239 68 68 / 0.15); color: var(--color-danger); }
  .draft-sent { background: rgba(99 102 241 / 0.15); color: var(--color-primary); }

  .draft-body {
    font-family: var(--font);
    font-size: 13px;
    line-height: 1.7;
    white-space: pre-wrap;
    background: var(--color-surface-2);
    padding: 14px;
    border-radius: var(--radius);
    margin-bottom: 14px;
  }

  .draft-actions { display: flex; gap: 10px; }
```

Leave `.draft-badge` on the thread list item styling untouched; it displays the historical `draft_count` number and is not part of the legacy render/approve/reject flow being retired here.

- [ ] **Step 3: Playwright verify the thread page**

Use `mcp__playwright__browser_navigate` to a thread detail page (`/threads/<id>` for any existing thread). Use `mcp__playwright__browser_snapshot` and confirm there is no "Drafts (" heading anywhere on the page, and that the "Send manual reply" panel (`ManualReplyPanel`) is still visible.

- [ ] **Step 4: Remove legacy drafts rendering from `frontend/src/routes/review/+page.svelte`**

Change the type import from:

```svelte
  import type { ThreadListItem, ThreadDetail, Draft, PlaybookRun } from "$lib/api";
```

to:

```svelte
  import type { ThreadListItem, ThreadDetail, PlaybookRun } from "$lib/api";
```

Remove the `editingBodies` state declaration:

```ts
  // Per-draft edit state: draftId → edited body
  let editingBodies = $state<Record<number, string>>({});
```

Change `openThread` from:

```ts
  async function openThread(id: number) {
    detailLoading = true;
    try {
      const res = await threadsApi.get(id);
      expandedThread = res.thread;
      for (const d of res.thread.drafts) {
        if (d.status === "pending") {
          editingBodies[d.id] = d.body;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load thread";
    } finally {
      detailLoading = false;
    }
  }
```

to:

```ts
  async function openThread(id: number) {
    detailLoading = true;
    try {
      const res = await threadsApi.get(id);
      expandedThread = res.thread;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load thread";
    } finally {
      detailLoading = false;
    }
  }
```

Remove this function entirely:

```ts
  async function handleDraftAction(
    threadId: number,
    draft: Draft,
    status: Draft["status"],
  ) {
    try {
      const editedBody =
        status === "approved" ? editingBodies[draft.id] : undefined;
      await threadsApi.updateDraftStatus(threadId, draft.id, status, editedBody);
      successMessage = `Draft ${status}.`;
      setTimeout(() => { successMessage = null; }, 3000);
      if (expandedThread?.id === threadId) {
        const res = await threadsApi.get(threadId);
        expandedThread = res.thread;
      }
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to update draft";
    }
  }
```

Remove this entire markup block (the "Drafts" section inside the thread detail panel):

```svelte
        {#if expandedThread.drafts.length > 0}
          <div class="drafts-section">
            <h3>Drafts</h3>
            {#each expandedThread.drafts as draft (draft.id)}
              <div class="draft card">
                <div class="draft-status-row">
                  <span class="draft-status draft-status-{draft.status}"
                    >{draft.status}</span
                  >
                  <span class="date"
                    >{new Date(draft.created_at).toLocaleString()}</span
                  >
                  {#if draft.was_edited}
                    <span class="edited-badge">edited</span>
                  {/if}
                </div>
                {#if draft.status === "pending"}
                  <textarea
                    class="draft-editor"
                    rows={10}
                    bind:value={editingBodies[draft.id]}
                  ></textarea>
                  {#if editingBodies[draft.id] !== draft.body}
                    <p class="edit-notice">
                      Body edited - changes will be sent on approval.
                    </p>
                  {/if}
                  <div class="draft-actions">
                    <button
                      class="btn btn-primary"
                      onclick={() =>
                        handleDraftAction(
                          expandedThread!.id,
                          draft,
                          "approved",
                        )}
                    >
                      Approve &amp; Send
                    </button>
                    <button
                      class="btn btn-ghost"
                      onclick={() => {
                        editingBodies[draft.id] = draft.body;
                      }}
                    >
                      Reset
                    </button>
                    <button
                      class="btn btn-danger"
                      onclick={() =>
                        handleDraftAction(
                          expandedThread!.id,
                          draft,
                          "rejected",
                        )}
                    >
                      Reject
                    </button>
                  </div>
                {:else}
                  <pre class="draft-body">{draft.final_body ?? draft.body}</pre>
                  {#if draft.sent_at}
                    <p class="sent-at">
                      Sent {new Date(draft.sent_at).toLocaleString()}
                    </p>
                  {/if}
                {/if}
              </div>
            {/each}
          </div>
        {/if}
```

Remove this CSS block from the `<style>` section (it becomes entirely dead once the markup above is gone; `.card`, `.select-prompt`, `.btn-danger` and the thread-list `.draft-badge` styles stay, they are used elsewhere in this file):

```css
  .draft-status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }

  .draft-status {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .draft-status-pending {
    background: rgba(245 158 11 / 0.15);
    color: var(--color-warning);
  }
  .draft-status-approved {
    background: rgba(16 185 129 / 0.15);
    color: var(--color-success);
  }
  .draft-status-rejected {
    background: rgba(239 68 68 / 0.15);
    color: var(--color-danger);
  }
  .draft-status-sent {
    background: rgba(59 130 246 / 0.15);
    color: var(--color-info);
  }

  .draft-editor {
    width: 100%;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    color: var(--color-text);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    padding: 12px;
    resize: vertical;
    margin-bottom: 8px;
  }

  .draft-editor:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .edit-notice {
    font-size: 12px;
    color: var(--color-info);
    margin-bottom: 8px;
  }

  .draft-body {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--color-text-muted);
    padding: 12px;
    background: var(--color-bg);
    border-radius: var(--radius);
    border: 1px solid var(--color-border);
    margin-bottom: 12px;
  }

  .draft-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
```

- [ ] **Step 5: Playwright verify the review page thread detail**

Use `mcp__playwright__browser_navigate` to `/review`. If any thread is listed, click it and use `mcp__playwright__browser_snapshot` to confirm there is no "Drafts" heading and no draft textarea in the thread detail pane, only the "Messages" section.

- [ ] **Step 6: Remove `threadsApi.updateDraftStatus` from `frontend/src/lib/api.ts`**

Remove this method from the `threadsApi` object:

```ts
	updateDraftStatus(threadId: number, draftId: number, status: Draft['status'], body?: string) {
		return request<{ draft: Draft }>(`/threads/${threadId}/drafts/${draftId}`, {
			method: 'PATCH',
			body: JSON.stringify({ status, ...(body !== undefined ? { body } : {}) })
		});
	},
```

Keep the `Draft` interface and `ThreadDetail.drafts` field; `GET /threads/:id` still returns them.

- [ ] **Step 7: Run the frontend typecheck**

Run: `cd frontend && npm run check`
Expected: `0 errors`.

- [ ] **Step 8: Retire the legacy draft endpoints in `api/routes/threads.ts`**

Change the imports at the top of the file from:

```ts
import { execute, query, queryOne } from "../db/client.ts";
import {
  AppError,
  Draft,
  Message,
  Thread,
  ThreadDetail,
  ThreadListItem,
  UpdateDraftStatusPayload,
} from "../types/index.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { categoriseAndDraft } from "../services/categorisation.ts";
import { sendReply } from "../services/gmail.ts";
import { recordInteraction } from "../services/learning.ts";
import { sendHumanReply } from "../services/human-reply.ts";
import { fetchThreadListItem } from "../db/queries.ts";
import { publish } from "../services/event-bus.ts";
import { resolveReplyAddress } from "../services/reply-address.ts";
```

to:

```ts
import { execute, query, queryOne } from "../db/client.ts";
import {
  AppError,
  Thread,
  ThreadDetail,
  ThreadListItem,
} from "../types/index.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { categoriseAndDraft } from "../services/categorisation.ts";
import { sendHumanReply } from "../services/human-reply.ts";
import { fetchThreadListItem } from "../db/queries.ts";
import { publish } from "../services/event-bus.ts";
```

Replace the two drafts routes:

```ts
// GET /threads/:id/drafts - list drafts for a thread
threadsRouter.get("/:id/drafts", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid thread ID");

  const drafts = await query(
    "SELECT * FROM drafts WHERE thread_id = $1 ORDER BY created_at DESC",
    [id],
  );
  return c.json({ drafts });
});

// PATCH /threads/:id/drafts/:draftId - approve / reject / mark sent
threadsRouter.patch("/:id/drafts/:draftId", async (c) => {
  const threadId = parseInt(c.req.param("id"));
  const draftId = parseInt(c.req.param("draftId"));
  if (isNaN(threadId) || isNaN(draftId)) throw new AppError(400, "Invalid ID");

  const body = await c.req.json<UpdateDraftStatusPayload>();
  const validStatuses = ["pending", "approved", "rejected", "sent"];
  if (!validStatuses.includes(body.status)) {
    throw new AppError(422, `status must be one of: ${validStatuses.join(", ")}`);
  }

  // Load draft and thread upfront for tracking.
  const [existingDraft, thread] = await Promise.all([
    queryOne<Draft>("SELECT * FROM drafts WHERE id = $1 AND thread_id = $2", [draftId, threadId]),
    queryOne<Thread>("SELECT * FROM threads WHERE id = $1", [threadId]),
  ]);
  if (!existingDraft) throw new AppError(404, "Draft not found");
  if (!thread) throw new AppError(404, "Thread not found");

  // When a draft is approved, send the reply via Gmail immediately.
  if (body.status === "approved") {
    const lastInbound = await queryOne<Message>(
      "SELECT * FROM messages WHERE thread_id = $1 AND direction = 'inbound' ORDER BY received_at DESC LIMIT 1",
      [threadId],
    );
    if (!lastInbound) throw new AppError(422, "No inbound message to reply to");
    const replyAddress = resolveReplyAddress(lastInbound);

    const tokenRow = await queryOne<{ email: string }>(
      "SELECT email FROM oauth_tokens WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1",
      [thread.workspace_id],
    );
    if (!tokenRow) throw new AppError(500, "No connected Gmail account");

    // Allow submitting an edited body alongside the approval.
    const submittedBody = typeof body.body === "string" ? body.body.trim() : null;
    const finalBody = submittedBody || existingDraft.body;
    const wasEdited = submittedBody !== null && submittedBody !== existingDraft.body.trim();
    const sentAt = new Date().toISOString();

    await sendReply(
      tokenRow.email,
      thread.gmail_thread_id,
      thread.subject,
      replyAddress.address,
      finalBody,
      lastInbound.message_id_header,
      thread.id,
    );

    // Mark draft as sent with full tracking metadata.
    await execute(
      `UPDATE drafts
       SET status = 'sent', was_edited = $1, final_body = $2, sent_at = $3
       WHERE id = $4`,
      [wasEdited, finalBody, sentAt, draftId],
    );
    await execute("UPDATE threads SET status = 'replied' WHERE id = $1", [threadId]);

    // Record the interaction for learning.
    await recordInteraction({
      workspaceId: thread.workspace_id,
      threadId: thread.id,
      categoryId: thread.category_id,
      draftId: existingDraft.id,
      outcome: wasEdited ? "edited" : "approved",
      originalBody: existingDraft.body,
      finalBody: finalBody,
    }).catch((err) => console.error("[threads] Failed to record interaction:", err));
  } else if (body.status === "rejected") {
    await execute(
      "UPDATE drafts SET status = 'rejected' WHERE id = $1",
      [draftId],
    );

    // Record rejection for learning.
    await recordInteraction({
      workspaceId: thread.workspace_id,
      threadId: thread.id,
      categoryId: thread.category_id,
      draftId: existingDraft.id,
      outcome: "rejected",
      originalBody: existingDraft.body,
      finalBody: null,
    }).catch((err) => console.error("[threads] Failed to record interaction:", err));
  } else {
    await execute(
      "UPDATE drafts SET status = $1 WHERE id = $2 AND thread_id = $3",
      [body.status, draftId, threadId],
    );
  }

  const draft = await queryOne("SELECT * FROM drafts WHERE id = $1", [draftId]);
  const threadItem = await fetchThreadListItem(threadId, thread.workspace_id);
  if (threadItem) {
    publish({
      type: "thread_updated",
      workspaceId: thread.workspace_id,
      thread: threadItem as unknown as Record<string, unknown>,
    });
  }
  return c.json({ draft });
});
```

with:

```ts
// GET /threads/:id/drafts - retired. Playbook pending-sends and manual replies
// are the single draft model now (docs/PLAYBOOK_ENGINE.md). The drafts table
// is kept for historical data; do not drop it until a prod check confirms no
// pending rows remain: SELECT count(*) FROM drafts WHERE status = 'pending';
threadsRouter.get("/:id/drafts", (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid thread ID");
  throw new AppError(
    410,
    "Legacy draft endpoint retired. Use playbook runs (/playbooks/runs) and manual replies (/threads/:id/manual-reply) instead.",
  );
});

// PATCH /threads/:id/drafts/:draftId - retired, see GET /threads/:id/drafts above.
threadsRouter.patch("/:id/drafts/:draftId", (c) => {
  const threadId = parseInt(c.req.param("id"));
  const draftId = parseInt(c.req.param("draftId"));
  if (isNaN(threadId) || isNaN(draftId)) throw new AppError(400, "Invalid ID");
  throw new AppError(
    410,
    "Legacy draft endpoint retired. Use playbook runs (/playbooks/runs) and manual replies (/threads/:id/manual-reply) instead.",
  );
});
```

- [ ] **Step 9: Run backend checks**

Run: `cd api && deno check main.ts`
Expected: no type errors.

Run: `cd api && deno test --allow-net --allow-env --allow-read`
Expected: all existing tests still pass (this task removes dead code paths with no prior test coverage, per Step 1).

- [ ] **Step 10: Remove `skipIfPendingDraft` from `api/services/categorisation.ts`**

In `categoriseAndDraft`, change:

```ts
  const workspaceId = thread.workspace_id;

  const skip = await skipIfPendingDraft(thread);
  if (skip) return skip;

  const [messages, categories, settingRows] = await Promise.all([
```

to:

```ts
  const workspaceId = thread.workspace_id;

  const [messages, categories, settingRows] = await Promise.all([
```

In `categoriseFromGmailLabels`, change:

```ts
  if (!thread) throw new AppError(404, "Thread not found");

  const skip = await skipIfPendingDraft(thread);
  if (skip) return skip;

  const categories = await query<Category>(
```

to:

```ts
  if (!thread) throw new AppError(404, "Thread not found");

  const categories = await query<Category>(
```

Remove this function entirely:

```ts
async function skipIfPendingDraft(thread: Thread): Promise<
  {
    thread: Thread;
    categoryId: number | null;
    confidence: number;
    reasoning: string;
    draftCreated: boolean;
  } | null
> {
  // If thread already has a category AND a pending draft, skip re-categorisation
  // to avoid clobbering existing state. Resume logic is Phase 2.
  if (thread.category_id === null) return null;

  const existingPendingDraft = await queryOne(
    "SELECT id FROM drafts WHERE thread_id = $1 AND status = 'pending'",
    [thread.id],
  );
  if (!existingPendingDraft) return null;

  console.log(
    `[categorisation] Thread ${thread.id} already categorised with pending draft - skipping`,
  );
  const currentThread = await queryOne<Thread>(
    "SELECT * FROM threads WHERE id = $1",
    [thread.id],
  ) as Thread;
  return {
    thread: currentThread,
    categoryId: thread.category_id,
    confidence: 1,
    reasoning: "Already categorised with pending draft; skipping re-categorisation.",
    draftCreated: false,
  };
}
```

- [ ] **Step 11: Run backend checks again**

Run: `cd api && deno check main.ts`
Expected: no type errors.

Run: `cd api && deno test --allow-net --allow-env --allow-read`
Expected: all tests pass.

- [ ] **Step 12: Commit**

```bash
git add frontend/src/routes/threads/[id]/+page.svelte frontend/src/routes/review/+page.svelte frontend/src/lib/api.ts api/routes/threads.ts api/services/categorisation.ts
git commit -m "Retire the legacy drafts-table flow, playbook pending-sends are the one draft model"
```

---

### Task 11: Human-looking replies

**Files:**
- Modify: `api/types/index.ts` (`GmailMessagePart` gains `filename`)
- Modify: `api/services/gmail.ts` (`formatFromHeader`, `appendSignature`, `appendAttachmentMarkers`, `extractBody`, `parseGmailMessageForIngest`, `sendReply`)
- Modify: `api/services/gmail_test.ts` (append tests; created in Task 6)

**Interfaces:**
- Consumes: `workspaces.store_name TEXT` (migration 025, existing); settings key `sender_name` (existing, already written by the Settings page "Email Signature" section at `frontend/src/routes/settings/+page.svelte:477-519`, and already read for the same purpose by `executor.ts`'s `advanceRun` today - confirmed the codebase has no separate freeform "signature text" setting, only this name).
- Produces: `formatFromHeader(storeName: string | null, email: string): string`, `appendSignature(body: string, senderName: string | null): string`, `appendAttachmentMarkers(text: string, filenames: string[]): string`, all exported from `api/services/gmail.ts`.

Design note: the fix lives centrally in `sendReply()` because every reply path (playbook auto-send, draft-only approval send, `ask_customer`, manual replies) already funnels through it (confirmed call sites: `api/services/human-reply.ts:83`, `api/services/playbook/approval-sender.ts:59`, `api/services/playbook/handlers/ask_customer.ts:52,238`, `api/services/playbook/handlers/send_reply.ts:138`, all passing `workspaceId` as the last argument already).

Sign-off note: Task 4's composer prompts (`composer.ts`) already instruct the AI to close the
message body with the sender's exact name ("Sign off using the exact name: {ctx.senderName}"),
using this same `sender_name` setting. `appendSignature` below is not just idempotent against its
own exact output, it treats the sender's name appearing anywhere in the body's last line as
"already signed" - an exact-string match alone would almost never fire, since the AI's closing
phrasing varies turn to turn ("Thanks, Kieran" one reply, "Cheers, Kieran" the next), so a naive
exact match would produce a double sign-off on nearly every send. The composer's in-body sign-off
stays as-is (Task 4 is not touched by this task); `appendSignature` is what backs off when it's
already there.

- [ ] **Step 1: Write the failing tests**

`gmail_test.ts` already exists (created in Task 6, currently 9 passing `resolveInboundRunAction`/
`appendMessageToWaitingRun` tests). First, widen its existing top-of-file import line from:

```ts
import { appendMessageToWaitingRun, resolveInboundRunAction } from "./gmail.ts";
```

to:

```ts
import {
  appendAttachmentMarkers,
  appendMessageToWaitingRun,
  appendSignature,
  formatFromHeader,
  resolveInboundRunAction,
} from "./gmail.ts";
```

Then append the following `Deno.test` blocks to the end of the existing `api/services/gmail_test.ts`
(after Task 6's tests, not replacing them):

```ts
Deno.test("formatFromHeader returns a quoted display name with the store name", () => {
  const result = formatFromHeader("Exclusive Motors", "store@example.com");
  assertEquals(result, '"Exclusive Motors" <store@example.com>');
});

Deno.test("formatFromHeader falls back to the bare address when store name is unset", () => {
  assertEquals(formatFromHeader(null, "store@example.com"), "store@example.com");
  assertEquals(formatFromHeader("   ", "store@example.com"), "store@example.com");
});

Deno.test("formatFromHeader escapes embedded quotes in the display name", () => {
  const result = formatFromHeader('The "Best" Store', "store@example.com");
  assertEquals(result, '"The \\"Best\\" Store" <store@example.com>');
});

Deno.test("appendSignature appends the configured signature when absent", () => {
  const result = appendSignature("Thanks for reaching out.", "Sarah from Support");
  assertEquals(result, "Thanks for reaching out.\n\nBest regards,\nSarah from Support");
});

Deno.test("appendSignature does not duplicate a signature already present", () => {
  const body = "Thanks for reaching out.\n\nBest regards,\nSarah from Support";
  assertEquals(appendSignature(body, "Sarah from Support"), body);
});

Deno.test("appendSignature does not double up when the AI already signed off with a different closing phrase", () => {
  // composer.ts's prompt tells the AI to close with the exact sender name, but
  // not in this literal "Best regards," phrasing - this is the real-world case
  // an exact-block idempotency check would miss.
  const body = "Thanks for reaching out.\n\nThanks,\nSarah from Support";
  assertEquals(appendSignature(body, "Sarah from Support"), body);
});

Deno.test("appendSignature returns the body unchanged when no signature is configured", () => {
  assertEquals(appendSignature("Thanks for reaching out.", null), "Thanks for reaching out.");
  assertEquals(appendSignature("Thanks for reaching out.", "  "), "Thanks for reaching out.");
});

Deno.test("appendAttachmentMarkers appends one marker per filename", () => {
  const result = appendAttachmentMarkers("Here is my order.", ["receipt.pdf", "photo.jpg"]);
  assertEquals(result, "Here is my order.\n\n[attachment: receipt.pdf]\n[attachment: photo.jpg]");
});

Deno.test("appendAttachmentMarkers returns the text unchanged when there are no attachments", () => {
  assertEquals(appendAttachmentMarkers("Here is my order.", []), "Here is my order.");
});

Deno.test("appendAttachmentMarkers works against an empty body", () => {
  assertEquals(appendAttachmentMarkers("", ["photo.jpg"]), "[attachment: photo.jpg]");
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `cd api && deno test --allow-net --allow-env --allow-read services/gmail_test.ts`
Expected: FAIL, `does not provide an export named 'formatFromHeader'` (none of the three new
functions exist in `gmail.ts` yet - the import-time failure means none of the tests in the file
run, including Task 6's 9 already-implemented ones; that is expected for this red step, not a
regression).

- [ ] **Step 3: Add `filename` to `GmailMessagePart` in `api/types/index.ts`**

Change:

```ts
export interface GmailMessagePart {
  partId?: string;
  mimeType: string;
  headers: Array<{ name: string; value: string }>;
  body: { size: number; data?: string };
  parts?: GmailMessagePart[];
}
```

to:

```ts
export interface GmailMessagePart {
  partId?: string;
  mimeType: string;
  // Present (non-empty) only on attachment parts, not on inline body parts.
  // Ref: Gmail API MessagePart resource, https://developers.google.com/gmail/api/reference/rest/v1/users.messages#MessagePart
  filename?: string;
  headers: Array<{ name: string; value: string }>;
  body: { size: number; data?: string };
  parts?: GmailMessagePart[];
}
```

- [ ] **Step 4: Implement `formatFromHeader` and `appendSignature` in `api/services/gmail.ts`**

Add these two functions right after `textToHtml`:

```ts
/**
 * Builds an RFC 5322 From header with an optional quoted display name.
 * Ref: RFC 5322 section 3.4, https://www.rfc-editor.org/rfc/rfc5322#section-3.4
 */
export function formatFromHeader(storeName: string | null, email: string): string {
  const trimmed = storeName?.trim();
  if (!trimmed) return email;
  const escaped = trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}" <${email}>`;
}

/**
 * Deterministically appends the store's configured signature to a reply
 * body. `senderName` is `settings.sender_name` (the only per-workspace
 * "signature" this codebase has - there is no separate freeform
 * signature-text setting, and the Settings page itself documents and
 * previews this exact "Best regards,\n{name}" format to the merchant).
 * Appends nothing when no name is configured.
 *
 * Idempotent, but not just against its own exact output: composer.ts's
 * prompts already tell the AI to close the body with this same name in its
 * own words ("Thanks, Kieran", "Cheers, Kieran", ...), so an exact-block
 * match alone would almost never catch that and would double the sign-off
 * on nearly every send. Instead this checks whether the sender's name
 * already appears in the body's last line - true for any phrasing the AI
 * used - and skips appending when it does.
 */
export function appendSignature(body: string, senderName: string | null): string {
  const trimmedName = senderName?.trim();
  if (!trimmedName) return body;

  const trimmedBody = body.trimEnd();
  const lines = trimmedBody.split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";
  if (lastLine.includes(trimmedName)) return trimmedBody;

  const signatureBlock = `Best regards,\n${trimmedName}`;
  return `${trimmedBody}\n\n${signatureBlock}`;
}
```

- [ ] **Step 5: Implement `appendAttachmentMarkers` and wire attachments through `extractBody`**

Change `extractBody` from:

```ts
function extractBody(msg: GmailMessage): { plain: string; html: string } {
  let plain = "";
  let html = "";

  function walk(part: GmailMessage["payload"]): void {
    if (part.mimeType === "text/plain" && part.body.data) {
      plain += decodeBase64Utf8(part.body.data);
    } else if (part.mimeType === "text/html" && part.body.data) {
      html += decodeBase64Utf8(part.body.data);
    }
    for (const child of part.parts ?? []) {
      walk(child);
    }
  }

  walk(msg.payload);
  return { plain, html };
}
```

to:

```ts
function extractBody(
  msg: GmailMessage,
): { plain: string; html: string; attachmentFilenames: string[] } {
  let plain = "";
  let html = "";
  const attachmentFilenames: string[] = [];

  function walk(part: GmailMessage["payload"]): void {
    if (part.filename && part.filename.trim().length > 0) {
      attachmentFilenames.push(part.filename);
    }
    if (part.mimeType === "text/plain" && part.body.data) {
      plain += decodeBase64Utf8(part.body.data);
    } else if (part.mimeType === "text/html" && part.body.data) {
      html += decodeBase64Utf8(part.body.data);
    }
    for (const child of part.parts ?? []) {
      walk(child);
    }
  }

  walk(msg.payload);
  return { plain, html, attachmentFilenames };
}

/**
 * Appends one "[attachment: filename]" line per attachment so the stored
 * transcript, and anything reading body_plain (composer, evaluate, triage),
 * can acknowledge attachments even though their content is never read.
 */
export function appendAttachmentMarkers(text: string, filenames: string[]): string {
  if (filenames.length === 0) return text;
  const markers = filenames.map((name) => `[attachment: ${name}]`).join("\n");
  return text ? `${text}\n\n${markers}` : markers;
}
```

Change `parseGmailMessageForIngest` from:

```ts
function parseGmailMessageForIngest(
  gmailMsg: GmailMessage,
  accountEmail: string,
): ParsedGmailMessage {
  const from = headerValue(gmailMsg, "From") ?? "";
  const { plain, html } = extractBody(gmailMsg);
  const readablePlain = getReadableEmailText({ body_plain: plain, body_html: html });
```

to:

```ts
function parseGmailMessageForIngest(
  gmailMsg: GmailMessage,
  accountEmail: string,
): ParsedGmailMessage {
  const from = headerValue(gmailMsg, "From") ?? "";
  const { plain, html, attachmentFilenames } = extractBody(gmailMsg);
  const readablePlain = appendAttachmentMarkers(
    getReadableEmailText({ body_plain: plain, body_html: html }),
    attachmentFilenames,
  );
```

(the rest of `parseGmailMessageForIngest` is unchanged, it already returns `plain: readablePlain` further down)

- [ ] **Step 6: Run the tests, confirm they pass**

Run: `cd api && deno test --allow-net --allow-env --allow-read services/gmail_test.ts`
Expected: `ok | 19 passed | 0 failed` - this file now holds both tasks' tests: Task 6's 9
(`resolveInboundRunAction`/`appendMessageToWaitingRun`) plus this task's 10 (3 `formatFromHeader`
+ 4 `appendSignature` + 3 `appendAttachmentMarkers`), 9 + 10 = 19.

- [ ] **Step 7: Wire the From header and signature into `sendReply`**

Change:

```ts
export async function sendReply(
  email: string,
  gmailThreadId: string,
  subject: string,
  replyToAddress: string,
  body: string,
  inReplyToMessageId?: string | null,
  /** DB thread.id - when provided the sent message is written immediately so
   *  it appears in the dashboard without waiting for the Pub/Sub webhook. */
  dbThreadId?: number,
  workspaceId = 1,
): Promise<void> {
  // Build an RFC 2822 reply message.
  // If we have the original email's Message-ID, use it for proper threading.
  // The threadId in the API request also helps Gmail place the sent message.
  const headers = [
    `From: ${email}`,
    `To: ${replyToAddress}`,
    `Subject: Re: ${subject.replace(/^Re:\s*/i, "")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
  ];

  if (inReplyToMessageId) {
    // Ensure it is wrapped in angle brackets (RFC 2822 requires this).
    const mid = inReplyToMessageId.startsWith("<") ? inReplyToMessageId : `<${inReplyToMessageId}>`;
    headers.push(`In-Reply-To: ${mid}`);
    headers.push(`References: ${mid}`);
  }

  const rawMessage = [...headers, "", textToHtml(body)].join("\r\n");
```

to:

```ts
export async function sendReply(
  email: string,
  gmailThreadId: string,
  subject: string,
  replyToAddress: string,
  body: string,
  inReplyToMessageId?: string | null,
  /** DB thread.id - when provided the sent message is written immediately so
   *  it appears in the dashboard without waiting for the Pub/Sub webhook. */
  dbThreadId?: number,
  workspaceId = 1,
): Promise<void> {
  // Look up the store display name and signature once, up front, so every
  // reply path (playbook auto-send, draft approval, ask_customer, manual
  // reply) gets the same human-looking From header and sign-off without
  // each caller repeating the lookup.
  const [workspaceRow, signatureRow] = await Promise.all([
    queryOne<{ store_name: string | null }>(
      "SELECT store_name FROM workspaces WHERE id = $1",
      [workspaceId],
    ),
    queryOne<{ value: string }>(
      "SELECT value FROM settings WHERE workspace_id = $1 AND key = 'sender_name'",
      [workspaceId],
    ),
  ]);

  const fromHeader = formatFromHeader(workspaceRow?.store_name ?? null, email);
  const signedBody = appendSignature(body, signatureRow?.value ?? null);

  // Build an RFC 2822 reply message.
  // If we have the original email's Message-ID, use it for proper threading.
  // The threadId in the API request also helps Gmail place the sent message.
  const headers = [
    `From: ${fromHeader}`,
    `To: ${replyToAddress}`,
    `Subject: Re: ${subject.replace(/^Re:\s*/i, "")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
  ];

  if (inReplyToMessageId) {
    // Ensure it is wrapped in angle brackets (RFC 2822 requires this).
    const mid = inReplyToMessageId.startsWith("<") ? inReplyToMessageId : `<${inReplyToMessageId}>`;
    headers.push(`In-Reply-To: ${mid}`);
    headers.push(`References: ${mid}`);
  }

  const rawMessage = [...headers, "", textToHtml(signedBody)].join("\r\n");
```

Further down in the same function, change the outbound message insert from:

```ts
  if (dbThreadId) {
    const sentMsg = await queryOne<Message>(
      `INSERT INTO messages
         (thread_id, gmail_message_id, from_address, body_plain, body_html, received_at, direction, message_id_header)
       VALUES ($1, $2, $3, $4, $5, $6, 'outbound', NULL)
       ON CONFLICT (gmail_message_id) DO NOTHING
       RETURNING *`,
      [dbThreadId, sent.id, email, body, "", new Date().toISOString()],
    );
    if (sentMsg) {
      publish({ type: "message_created", workspaceId, threadId: dbThreadId, message: sentMsg });
    }
  }
```

to:

```ts
  if (dbThreadId) {
    // Store the signed body (what was actually sent), not the raw pre-signature
    // body, so the dashboard's transcript matches what the customer received.
    const sentMsg = await queryOne<Message>(
      `INSERT INTO messages
         (thread_id, gmail_message_id, from_address, body_plain, body_html, received_at, direction, message_id_header)
       VALUES ($1, $2, $3, $4, $5, $6, 'outbound', NULL)
       ON CONFLICT (gmail_message_id) DO NOTHING
       RETURNING *`,
      [dbThreadId, sent.id, email, signedBody, "", new Date().toISOString()],
    );
    if (sentMsg) {
      publish({ type: "message_created", workspaceId, threadId: dbThreadId, message: sentMsg });
    }
  }
```

- [ ] **Step 8: Run the full backend test suite and typecheck**

Run: `cd api && deno test --allow-net --allow-env --allow-read`
Expected: all tests pass, including all 19 `gmail_test.ts` cases (9 from Task 6, 10 from this
task).

Run: `cd api && deno check main.ts`
Expected: no type errors.

- [ ] **Step 9: Commit**

```bash
git add api/types/index.ts api/services/gmail.ts api/services/gmail_test.ts
git commit -m "Send human-looking replies: display name, deterministic signature, attachment markers"
```

---

### Task 12: Trust ramp

**Files:**
- Modify: `api/services/playbook/types.ts` (`Playbook` interface gains `approval_streak`, `auto_send_streak_target`)
- Create: `api/services/playbook/trust-ramp.ts`
- Test: Create `api/services/playbook/trust-ramp_test.ts`
- Modify: `api/services/event-bus.ts` (`BusEvent` gains `playbook_graduated`)
- Modify: `api/services/alerts.ts` (`AlertEvent` gains `playbook_graduated`)
- Modify: `api/routes/playbooks.ts` (wire `recordApprovalOutcome` into approve/reject; add `POST /:id/revert-to-draft`; add streak columns to `GET /runs`)
- Modify: `frontend/src/lib/api.ts` (`Playbook`/`PlaybookRun` gain streak fields; `playbooksApi.revertToDraft`)
- Modify: `frontend/src/routes/playbooks/+page.svelte` (streak progress, revert button, graduation banner)
- Modify: `frontend/src/routes/review/+page.svelte` (streak progress on pending runs, graduation banner, extends Task 9's SSE effect)
- Test: Playwright MCP verification

**Interfaces:**
- Consumes: `playbooks.approval_streak INT DEFAULT 0`, `playbooks.auto_send_streak_target INT DEFAULT 10` (migration 028, earlier phase, already applied); `playbooks.reply_mode` (existing column); `openSSE` and the workspace SSE channel already wired in Task 9's `review/+page.svelte` effect.
- Produces: `recordApprovalOutcome(runId: number, outcome: "approved_clean" | "approved_edited" | "rejected"): Promise<{ graduated: boolean }>`; `revertToDraftOnly(playbookId: number): Promise<Playbook | null>`; `computeStreakTransition(state: StreakState, outcome: ApprovalOutcome): StreakTransition` (all in `api/services/playbook/trust-ramp.ts`); `POST /playbooks/:id/revert-to-draft`; `BusEvent` variant `playbook_graduated`.

- [ ] **Step 1: Add the streak fields to the backend `Playbook` type**

In `api/services/playbook/types.ts`, change:

```ts
export interface Playbook {
  id: number;
  workspace_id: number;
  category_id: number | null;
  name: string;
  plain_language_description: string | null;
  steps: PlaybookStep[];
  version: number;
  is_active: boolean;
  customer_silence_hours: number;
  writing_style: string;
  reply_mode: "auto_reply" | "draft_only";
  confidence_threshold: number;
  created_at: Date;
  updated_at: Date;
}
```

to:

```ts
export interface Playbook {
  id: number;
  workspace_id: number;
  category_id: number | null;
  name: string;
  plain_language_description: string | null;
  steps: PlaybookStep[];
  version: number;
  is_active: boolean;
  customer_silence_hours: number;
  writing_style: string;
  reply_mode: "auto_reply" | "draft_only";
  confidence_threshold: number;
  approval_streak: number;
  auto_send_streak_target: number;
  created_at: Date;
  updated_at: Date;
}
```

- [ ] **Step 2: Write the failing test for the pure streak transition logic**

Create `api/services/playbook/trust-ramp_test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeStreakTransition } from "./trust-ramp.ts";

const baseState = { approvalStreak: 0, autoSendStreakTarget: 10, replyMode: "draft_only" as const };

Deno.test("computeStreakTransition increments the streak on a clean approval", () => {
  const result = computeStreakTransition({ ...baseState, approvalStreak: 4 }, "approved_clean");
  assertEquals(result.nextApprovalStreak, 5);
  assertEquals(result.graduated, false);
  assertEquals(result.nextReplyMode, "draft_only");
});

Deno.test("computeStreakTransition resets the streak on an edited approval", () => {
  const result = computeStreakTransition({ ...baseState, approvalStreak: 7 }, "approved_edited");
  assertEquals(result.nextApprovalStreak, 0);
  assertEquals(result.graduated, false);
});

Deno.test("computeStreakTransition resets the streak on rejection", () => {
  const result = computeStreakTransition({ ...baseState, approvalStreak: 9 }, "rejected");
  assertEquals(result.nextApprovalStreak, 0);
  assertEquals(result.graduated, false);
});

Deno.test("computeStreakTransition graduates to auto_reply when the target is reached", () => {
  const result = computeStreakTransition({ ...baseState, approvalStreak: 9 }, "approved_clean");
  assertEquals(result.nextApprovalStreak, 10);
  assertEquals(result.nextReplyMode, "auto_reply");
  assertEquals(result.graduated, true);
});

Deno.test("computeStreakTransition keeps counting once already auto_reply without re-graduating", () => {
  const result = computeStreakTransition(
    { approvalStreak: 12, autoSendStreakTarget: 10, replyMode: "auto_reply" },
    "approved_clean",
  );
  assertEquals(result.nextApprovalStreak, 13);
  assertEquals(result.graduated, false);
  assertEquals(result.nextReplyMode, "auto_reply");
});
```

- [ ] **Step 3: Run the test, confirm it fails**

Run: `cd api && deno test --allow-net --allow-env --allow-read services/playbook/trust-ramp_test.ts`
Expected: FAIL, module `./trust-ramp.ts` not found.

- [ ] **Step 4: Create `api/services/playbook/trust-ramp.ts`**

This follows the same pure-decision-plus-thin-wrapper pattern already used by `resolveTriageDecision` in `api/services/playbook/handlers/triage.ts`, since the repo has no DB-backed test harness (confirmed: none of `google-auth_test.ts`, `email-text_test.ts`, `reply-address_test.ts`, `triage_test.ts` touch the database).

```ts
/**
 * Trust ramp service.
 * Tracks consecutive clean (unedited) draft approvals per playbook and
 * promotes reply_mode from draft_only to auto_reply once the streak target
 * is reached. Editing a draft before approval, or rejecting it outright,
 * resets the streak, since the ramp only rewards drafts a human found good
 * enough to send unchanged.
 */
import { queryOne } from "../../db/client.ts";
import { publish } from "../event-bus.ts";
import { sendAlert } from "../alerts.ts";
import type { Playbook } from "./types.ts";

export type ApprovalOutcome = "approved_clean" | "approved_edited" | "rejected";

export interface StreakState {
  approvalStreak: number;
  autoSendStreakTarget: number;
  replyMode: "auto_reply" | "draft_only";
}

export interface StreakTransition {
  nextApprovalStreak: number;
  nextReplyMode: "auto_reply" | "draft_only";
  graduated: boolean;
}

/**
 * Pure decision: given the current streak state and what just happened,
 * what the new streak and reply_mode should be. Kept free of I/O so the
 * ramp logic itself is directly unit-testable.
 */
export function computeStreakTransition(
  state: StreakState,
  outcome: ApprovalOutcome,
): StreakTransition {
  const advanced = outcome === "approved_clean" ? state.approvalStreak + 1 : 0;
  const graduated = state.replyMode === "draft_only" && advanced >= state.autoSendStreakTarget;

  return {
    nextApprovalStreak: graduated ? state.autoSendStreakTarget : advanced,
    nextReplyMode: graduated ? "auto_reply" : state.replyMode,
    graduated,
  };
}

/**
 * Updates the streak for the playbook behind the given run and, when the
 * transition graduates it to auto_reply, announces the graduation over the
 * event bus and the alert webhook.
 */
export async function recordApprovalOutcome(
  runId: number,
  outcome: ApprovalOutcome,
): Promise<{ graduated: boolean }> {
  const run = await queryOne<{ playbook_id: number; workspace_id: number }>(
    "SELECT playbook_id, workspace_id FROM playbook_runs WHERE id = $1",
    [runId],
  );
  if (!run) return { graduated: false };

  const playbook = await queryOne<Playbook>(
    "SELECT * FROM playbooks WHERE id = $1",
    [run.playbook_id],
  );
  if (!playbook) return { graduated: false };

  const transition = computeStreakTransition(
    {
      approvalStreak: playbook.approval_streak,
      autoSendStreakTarget: playbook.auto_send_streak_target,
      replyMode: playbook.reply_mode,
    },
    outcome,
  );

  const updated = await queryOne<Playbook>(
    `UPDATE playbooks SET approval_streak = $1, reply_mode = $2 WHERE id = $3 RETURNING *`,
    [transition.nextApprovalStreak, transition.nextReplyMode, playbook.id],
  );
  if (!updated) return { graduated: false };

  if (transition.graduated) {
    publish({
      type: "playbook_graduated",
      workspaceId: run.workspace_id,
      playbook: {
        id: updated.id,
        name: updated.name,
        category_id: updated.category_id,
        reply_mode: updated.reply_mode,
      },
    });
    await sendAlert(run.workspace_id, "playbook_graduated", {
      playbook_id: updated.id,
      playbook_name: updated.name,
      category_id: updated.category_id,
    });
  }

  return { graduated: transition.graduated };
}

/**
 * One-click revert: sends the playbook back to draft_only and resets the
 * approval streak to zero, so it must re-earn auto-send.
 */
export async function revertToDraftOnly(playbookId: number): Promise<Playbook | null> {
  return await queryOne<Playbook>(
    `UPDATE playbooks SET reply_mode = 'draft_only', approval_streak = 0 WHERE id = $1 RETURNING *`,
    [playbookId],
  );
}
```

- [ ] **Step 5: Run the test, confirm it passes**

Run: `cd api && deno test --allow-net --allow-env --allow-read services/playbook/trust-ramp_test.ts`
Expected: `ok | 5 passed | 0 failed`.

- [ ] **Step 6: Add `playbook_graduated` to the event bus and alert types**

In `api/services/event-bus.ts`, change:

```ts
export type BusEvent =
  | { type: "thread_created"; workspaceId: number; thread: Record<string, unknown> }
  | { type: "thread_updated"; workspaceId: number; thread: Record<string, unknown> }
  | { type: "message_created"; workspaceId: number; threadId: number; message: Message }
  | { type: "run_updated"; workspaceId: number; threadId: number; run: PlaybookRun & { playbook_name?: string } }
  | { type: "step_execution_created"; workspaceId: number; runId: number; threadId: number; execution: StepExecution }
  | { type: "step_execution_updated"; workspaceId: number; runId: number; threadId: number; execution: StepExecution };
```

to:

```ts
export type BusEvent =
  | { type: "thread_created"; workspaceId: number; thread: Record<string, unknown> }
  | { type: "thread_updated"; workspaceId: number; thread: Record<string, unknown> }
  | { type: "message_created"; workspaceId: number; threadId: number; message: Message }
  | { type: "run_updated"; workspaceId: number; threadId: number; run: PlaybookRun & { playbook_name?: string } }
  | { type: "step_execution_created"; workspaceId: number; runId: number; threadId: number; execution: StepExecution }
  | { type: "step_execution_updated"; workspaceId: number; runId: number; threadId: number; execution: StepExecution }
  | {
      type: "playbook_graduated";
      workspaceId: number;
      playbook: { id: number; name: string; category_id: number | null; reply_mode: string };
    };
```

In `api/services/alerts.ts`, change:

```ts
export type AlertEvent =
  | "run_escalated"
  | "ingestion_failed_permanently"
  | "circuit_breaker_opened"
  | "rate_limit_sustained";
```

to:

```ts
export type AlertEvent =
  | "run_escalated"
  | "ingestion_failed_permanently"
  | "circuit_breaker_opened"
  | "rate_limit_sustained"
  | "playbook_graduated";
```

- [ ] **Step 7: Wire `recordApprovalOutcome` into the approve/reject routes and add the revert route**

In `api/routes/playbooks.ts`, add to the imports:

```ts
import { recordApprovalOutcome, revertToDraftOnly } from "../services/playbook/trust-ramp.ts";
```

In the `GET /runs` handler, change the SQL and the generic type to include the streak columns. Change:

```ts
  const runs = await query<
    PlaybookRun & {
      playbook_name: string;
      step_reason: string | null;
```

to:

```ts
  const runs = await query<
    PlaybookRun & {
      playbook_name: string;
      approval_streak: number;
      auto_send_streak_target: number;
      step_reason: string | null;
```

and change:

```ts
    `SELECT pr.*, p.name AS playbook_name,
```

to:

```ts
    `SELECT pr.*, p.name AS playbook_name, p.approval_streak, p.auto_send_streak_target,
```

In the `POST /runs/:runId/approve` handler, inside the `if (output?.action === "pending_approval" && ...)` block, change:

```ts
    if (output?.action === "pending_approval" && typeof output.pending_send === "string") {
      // Use human-edited body if provided, otherwise use the AI-drafted body
      const sendBody = (typeof body.body === "string" && body.body.trim())
        ? body.body.trim()
        : output.pending_send as string;
      await sendApprovedReply(run, sendBody);

      const stepType = currentStep.type;
```

to:

```ts
    if (output?.action === "pending_approval" && typeof output.pending_send === "string") {
      // Use human-edited body if provided, otherwise use the AI-drafted body
      const sendBody = (typeof body.body === "string" && body.body.trim())
        ? body.body.trim()
        : output.pending_send as string;
      await sendApprovedReply(run, sendBody);

      const wasEdited = typeof body.body === "string" && body.body.trim().length > 0 &&
        body.body.trim() !== (output.pending_send as string).trim();
      await recordApprovalOutcome(runId, wasEdited ? "approved_edited" : "approved_clean");

      const stepType = currentStep.type;
```

In the `POST /runs/:runId/reject` handler, Task 5 Step 8 already rewrote this branch to call
`finalizeEscalation` (recording a real reason, moving the thread to `in_review`, firing the
alert, and publishing SSE - see that step for the full before/after). This task only adds the
streak-tracking call on top of that, it must not reintroduce the old bare `UPDATE ... SET
status = 'escalated'` Task 5 already deleted. Change:

```ts
  if (currentStep.type === "ask_customer" || currentStep.type === "send_reply") {
    // Converges with the manual_approval reject flow below: both end up calling
    // finalizeEscalation, so both record a real reason, surface the thread for
    // review, fire the alert, and publish SSE the same way.
    const currentContext = typeof run.context === "string"
      ? JSON.parse(run.context)
      : { ...run.context };
    const rejectionReason =
      `Rejected by human: draft for ${currentStep.type} step "${currentStep.id}" was not approved`;
    await finalizeEscalation(
      runId,
      run.thread_id,
      run.workspace_id,
      currentContext,
      run.current_step_id,
      rejectionReason,
    );
    const updated = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [
      runId,
    ]);
    return c.json({ run: updated, result: { action: "escalated", reason: rejectionReason } });
  }
```

to:

```ts
  if (currentStep.type === "ask_customer" || currentStep.type === "send_reply") {
    // Converges with the manual_approval reject flow below: both end up calling
    // finalizeEscalation, so both record a real reason, surface the thread for
    // review, fire the alert, and publish SSE the same way.
    const currentContext = typeof run.context === "string"
      ? JSON.parse(run.context)
      : { ...run.context };
    const rejectionReason =
      `Rejected by human: draft for ${currentStep.type} step "${currentStep.id}" was not approved`;
    await recordApprovalOutcome(runId, "rejected");
    await finalizeEscalation(
      runId,
      run.thread_id,
      run.workspace_id,
      currentContext,
      run.current_step_id,
      rejectionReason,
    );
    const updated = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [
      runId,
    ]);
    return c.json({ run: updated, result: { action: "escalated", reason: rejectionReason } });
  }
```

`finalizeEscalation` stays the sole terminal write for this branch - `recordApprovalOutcome` only
resets the playbook's approval streak, it does not touch `playbook_runs.status` itself.

Add the revert route near `POST /:id/activate` and `POST /:id/deactivate`:

```ts
// POST /playbooks/:id/revert-to-draft
playbooksRouter.post("/:id/revert-to-draft", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid playbook ID");

  const updated = await revertToDraftOnly(id);
  if (!updated) throw new AppError(404, "Playbook not found");

  return c.json({ playbook: updated });
});
```

- [ ] **Step 8: Run backend checks**

Run: `cd api && deno check main.ts`
Expected: no type errors.

Run: `cd api && deno test --allow-net --allow-env --allow-read`
Expected: all tests pass, including the 5 new `trust-ramp_test.ts` cases.

- [ ] **Step 9: Add the streak fields and new API methods to `frontend/src/lib/api.ts`**

Change the `Playbook` interface from:

```ts
export interface Playbook {
        id: number;
        workspace_id: number;
        category_id: number | null;
        category_name?: string | null;
        name: string;
        plain_language_description: string | null;
        steps: PlaybookStep[];
        version: number;
        is_active: boolean;
        customer_silence_hours: number;
        writing_style: string;
        reply_mode: 'auto_reply' | 'draft_only';
        confidence_threshold: number;
        created_at: string;
        updated_at: string;
}
```

to:

```ts
export interface Playbook {
        id: number;
        workspace_id: number;
        category_id: number | null;
        category_name?: string | null;
        name: string;
        plain_language_description: string | null;
        steps: PlaybookStep[];
        version: number;
        is_active: boolean;
        customer_silence_hours: number;
        writing_style: string;
        reply_mode: 'auto_reply' | 'draft_only';
        confidence_threshold: number;
        approval_streak: number;
        auto_send_streak_target: number;
        created_at: string;
        updated_at: string;
}
```

Change the `PlaybookRun` interface's last field from:

```ts
        // True when an old run points at a step that no longer exists in its playbook snapshot.
        step_missing?: boolean | null;
}
```

to:

```ts
        // True when an old run points at a step that no longer exists in its playbook snapshot.
        step_missing?: boolean | null;
        // Trust-ramp streak fields, joined from the run's playbook.
        approval_streak?: number;
        auto_send_streak_target?: number;
}
```

Add this method to `playbooksApi`, near `activate`/`deactivate`:

```ts
        revertToDraft(id: number) {
                return request<{ playbook: Playbook }>(`/playbooks/${id}/revert-to-draft`, { method: 'POST' });
        },
```

- [ ] **Step 10: Run the frontend typecheck**

Run: `cd frontend && npm run check`
Expected: `0 errors`.

- [ ] **Step 11: Show streak progress, graduation banner, and revert on `/playbooks`**

In `frontend/src/routes/playbooks/+page.svelte`, change the icon import from:

```svelte
  import { ClipboardList, Trash2 } from '@lucide/svelte';
```

to:

```svelte
  import { ClipboardList, Trash2, CheckCircle, RefreshCw } from '@lucide/svelte';
```

(`CheckCircle` and `RefreshCw` are both already verified to exist in this exact `@lucide/svelte` version, used elsewhere in the frontend.)

Add the SSE import:

```svelte
  import { openSSE } from "$lib/sse";
```

Add state near the other `let ... = $state(...)` declarations:

```ts
  let graduationBanner = $state<string | null>(null);
```

Add this function near `deletePlaybook`:

```ts
  async function revertToDraft(pb: Playbook) {
    if (!confirm(`Revert "${pb.name}" to draft-only? This resets its approval streak to 0.`)) return;
    error = null;
    try {
      await playbooksApi.revertToDraft(pb.id);
      flash("Reverted to draft-only.");
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to revert";
    }
  }
```

After the existing `onMount(() => { load(); mounted = true; });` block, add:

```ts
  $effect(() => {
    const wsId = currentWorkspaceId;
    const es = openSSE('workspace', { workspace_id: wsId });

    es.addEventListener('playbook_graduated', (e: Event) => {
      const { playbook } = JSON.parse((e as MessageEvent).data) as {
        playbook: { id: number; name: string };
      };
      graduationBanner = `"${playbook.name}" graduated to auto-send after a clean approval streak.`;
      setTimeout(() => { graduationBanner = null; }, 8000);
      load();
    });

    return () => es.close();
  });
```

Add the banner markup right after the existing `{#if success}...{/if}` block:

```svelte
{#if graduationBanner}
  <div class="graduation-banner" transition:fade={{ duration: 150 }}>
    <CheckCircle size={16} /> {graduationBanner}
  </div>
{/if}
```

Change the `.pb-actions` block from:

```svelte
              <div class="pb-actions">
                <span class="status-dot" class:active={row.playbook.is_active} class:inactive={!row.playbook.is_active}></span>
                <button class="btn-action" onclick={() => toggleActive(row.playbook!)}>
                  {row.playbook.is_active ? "Deactivate" : "Activate"}
                </button>
                <a href="/playbooks/{row.playbook.id}" class="btn-action">Edit</a>
                <button class="btn-action danger" onclick={() => deletePlaybook(row.playbook!)} title="Delete playbook">
                  <Trash2 size={13} />
                </button>
              </div>
```

to:

```svelte
              <div class="pb-actions">
                <span class="status-dot" class:active={row.playbook.is_active} class:inactive={!row.playbook.is_active}></span>
                {#if row.playbook.reply_mode === 'draft_only'}
                  <span class="streak-badge" title="Consecutive clean approvals before auto-send">
                    {row.playbook.approval_streak}/{row.playbook.auto_send_streak_target} clean approvals
                  </span>
                {:else}
                  <span class="streak-badge streak-badge-graduated">
                    <CheckCircle size={12} /> Auto-send
                  </span>
                  <button class="btn-action" onclick={() => revertToDraft(row.playbook!)}>
                    <RefreshCw size={12} /> Revert to draft
                  </button>
                {/if}
                <button class="btn-action" onclick={() => toggleActive(row.playbook!)}>
                  {row.playbook.is_active ? "Deactivate" : "Activate"}
                </button>
                <a href="/playbooks/{row.playbook.id}" class="btn-action">Edit</a>
                <button class="btn-action danger" onclick={() => deletePlaybook(row.playbook!)} title="Delete playbook">
                  <Trash2 size={13} />
                </button>
              </div>
```

Add this CSS inside the `<style>` block, near `.status-dot`:

```css
  .streak-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  .streak-badge-graduated {
    color: var(--color-success);
    font-weight: 600;
  }

  .graduation-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(16 185 129 / 0.1);
    border: 1px solid rgba(16 185 129 / 0.3);
    border-radius: var(--radius);
    color: var(--color-success);
    padding: 12px 16px;
    margin-bottom: 16px;
    font-size: 13px;
    font-weight: 500;
  }
```

- [ ] **Step 12: Show streak progress and graduation banner on `/review`**

Extend the SSE `$effect` block already added in Task 9 (`frontend/src/routes/review/+page.svelte`) with a `playbook_graduated` listener. Change:

```ts
  $effect(() => {
    let connectionCount = 0;
    const es = openSSE('workspace', { workspace_id: 1 });

    es.addEventListener('open', () => {
      connectionCount++;
      // A reconnect after the first connection means we missed events while
      // disconnected, so do a full reload rather than trust partial state.
      if (connectionCount > 1) load();
    });

    es.addEventListener('thread_updated', () => {
      load();
    });

    es.addEventListener('run_updated', () => {
      load();
    });

    return () => es.close();
  });
```

to:

```ts
  $effect(() => {
    let connectionCount = 0;
    const es = openSSE('workspace', { workspace_id: 1 });

    es.addEventListener('open', () => {
      connectionCount++;
      // A reconnect after the first connection means we missed events while
      // disconnected, so do a full reload rather than trust partial state.
      if (connectionCount > 1) load();
    });

    es.addEventListener('thread_updated', () => {
      load();
    });

    es.addEventListener('run_updated', () => {
      load();
    });

    es.addEventListener('playbook_graduated', (e: Event) => {
      const { playbook } = JSON.parse((e as MessageEvent).data) as {
        playbook: { id: number; name: string };
      };
      graduationBanner = `"${playbook.name}" graduated to auto-send after a clean approval streak.`;
      setTimeout(() => { graduationBanner = null; }, 8000);
      load();
    });

    return () => es.close();
  });
```

Add state near the other `let ... = $state(...)` declarations:

```ts
  let graduationBanner = $state<string | null>(null);
```

Add the banner markup right after the existing `{#if successMessage}...{/if}` block:

```svelte
{#if graduationBanner}
  <div class="graduation-banner" transition:fade={{ duration: 150 }}>
    <CheckCircle size={16} /> {graduationBanner}
  </div>
{/if}
```

Inside the pending-run card, right after the `<span class="approval-time">{new Date(run.updated_at).toLocaleString()}</span>` line, add:

```svelte
              {#if run.auto_send_streak_target != null}
                <span class="approval-streak">{run.approval_streak ?? 0}/{run.auto_send_streak_target} clean approvals</span>
              {/if}
```

Add this CSS inside the `<style>` block, near `.approval-time`:

```css
  .approval-streak {
    font-size: 11px;
    color: var(--color-text-muted);
  }

  .graduation-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(16 185 129 / 0.1);
    border: 1px solid rgba(16 185 129 / 0.3);
    border-radius: var(--radius);
    color: var(--color-success);
    padding: 12px 16px;
    margin-bottom: 16px;
    font-size: 13px;
    font-weight: 500;
  }
```

- [ ] **Step 13: Run the frontend typecheck**

Run: `cd frontend && npm run check`
Expected: `0 errors`.

- [ ] **Step 14: Playwright verify the ramp end to end**

Use `mcp__playwright__browser_navigate` to `/playbooks`. Use `mcp__playwright__browser_snapshot` and confirm each `draft_only` category row shows "X/10 clean approvals" text. Approve a pending draft cleanly (no edits) via `/review` (`browser_navigate` to `/review`, `browser_click` "Approve") and use `postgres` MCP (`SELECT approval_streak, reply_mode FROM playbooks WHERE id = <id>;`) to confirm the streak incremented by 1. Edit a pending draft's textarea before approving and confirm the streak resets to 0. Reject a pending draft and confirm the streak resets to 0. If a category's `auto_send_streak_target` is reachable in the seeded data, drive it to graduation and confirm the graduation banner appears on both `/playbooks` and `/review`, and that `reply_mode` reads `auto_reply` via the postgres MCP query. Click "Revert to draft" on a graduated row and confirm `reply_mode` returns to `draft_only` and `approval_streak` returns to `0`.

- [ ] **Step 15: Commit**

```bash
git add api/services/playbook/types.ts api/services/playbook/trust-ramp.ts api/services/playbook/trust-ramp_test.ts api/services/event-bus.ts api/services/alerts.ts api/routes/playbooks.ts frontend/src/lib/api.ts frontend/src/routes/playbooks/+page.svelte frontend/src/routes/review/+page.svelte
git commit -m "Add the trust ramp: streak tracking, auto-send graduation, one-click revert"
```

---

### Task 13: Dry-run + docs truth-up

**Files:**
- Modify: `api/services/playbook/dry-run.ts` (`getModel`, `followUpMessage` resume support)
- Modify: `api/services/playbook/parser.ts` (`getModel` in both AI call sites)
- Modify: `api/routes/playbooks.ts` (dry-run route accepts `follow_up_message`)
- Modify: `frontend/src/lib/api.ts` (`playbooksApi.dryRun` gains optional `followUpMessage`)
- Test: Create `api/services/playbook/dry-run_test.ts`
- Modify: `CLAUDE.md` (known-issues section)
- Modify: `docs/PLAYBOOK_ENGINE.md` (step table + flow diagram)
- Modify: `docs/TASK_LOG.md` (new top entry)

**Interfaces:**
- Consumes: `getModel(workspaceId = 1): Promise<string>` from `api/services/ai.ts:21-27` (existing, already used by every other AI call site in the playbook engine).
- Produces: `resolveSimulatedFollowUp(askStep: AskCustomerStep, currentEmailContent: string, followUpMessage: string | undefined, followUpConsumed: boolean): { consumed: false } | { consumed: true; nextEmailContent: string; nextStepId: string }`; `dryRunPlaybook(playbookId, emailContent, workspaceId, followUpMessage?)` signature gains a 4th optional param; `playbooksApi.dryRun(id, emailContent, workspaceId?, followUpMessage?)`.

- [ ] **Step 1: Write the failing test for the pure follow-up-resume logic**

Create `api/services/playbook/dry-run_test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveSimulatedFollowUp } from "./dry-run.ts";
import type { AskCustomerStep } from "./types.ts";

const askStep: AskCustomerStep = {
  id: "ask_1",
  type: "ask_customer",
  on_reply_goto: "send_1",
};

Deno.test("resolveSimulatedFollowUp is a no-op when no follow-up message is provided", () => {
  const result = resolveSimulatedFollowUp(askStep, "Hi, where is my order?", undefined, false);
  assertEquals(result.consumed, false);
});

Deno.test("resolveSimulatedFollowUp is a no-op once already consumed", () => {
  const result = resolveSimulatedFollowUp(askStep, "Hi, where is my order?", "It's order #123", true);
  assertEquals(result.consumed, false);
});

Deno.test("resolveSimulatedFollowUp injects the reply and resumes at on_reply_goto", () => {
  const result = resolveSimulatedFollowUp(askStep, "Hi, where is my order?", "It's order #123", false);
  assertEquals(result.consumed, true);
  if (result.consumed) {
    assertEquals(result.nextStepId, "send_1");
    assertEquals(
      result.nextEmailContent,
      "Hi, where is my order?\n\n---\n\n[Simulated customer reply]\nIt's order #123",
    );
  }
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `cd api && deno test --allow-net --allow-env --allow-read services/playbook/dry-run_test.ts`
Expected: FAIL, `does not provide an export named 'resolveSimulatedFollowUp'`.

- [ ] **Step 3: Implement `resolveSimulatedFollowUp` and wire it into `dryRunPlaybook`**

In `api/services/playbook/dry-run.ts`, add this import:

```ts
import { chatCompletion, getModel } from "../ai.ts";
```

(replacing the current `import { chatCompletion } from "../ai.ts";`)

Add this pure function right after `nextStep`:

```ts
/**
 * Decides whether a simulated follow-up message should be consumed at this
 * ask_customer pause, and if so, the updated email content and next step.
 * Pure so the resume-path branching is unit-testable without a live playbook.
 */
export function resolveSimulatedFollowUp(
  askStep: AskCustomerStep,
  currentEmailContent: string,
  followUpMessage: string | undefined,
  followUpConsumed: boolean,
): { consumed: false } | { consumed: true; nextEmailContent: string; nextStepId: string } {
  if (!followUpMessage || followUpConsumed) return { consumed: false };
  return {
    consumed: true,
    nextEmailContent: `${currentEmailContent}\n\n---\n\n[Simulated customer reply]\n${followUpMessage}`,
    nextStepId: askStep.on_reply_goto,
  };
}
```

Change the function signature from:

```ts
export async function dryRunPlaybook(
  playbookId: number,
  emailContent: string,
  workspaceId: number,
): Promise<DryRunResult> {
```

to:

```ts
export async function dryRunPlaybook(
  playbookId: number,
  emailContent: string,
  workspaceId: number,
  followUpMessage?: string,
): Promise<DryRunResult> {
```

Change the setup block from:

```ts
  const context: Record<string, unknown> = {};
  const trace: DryRunTraceEntry[] = [];
  const MAX_ITERATIONS = 50;
  let iterations = 0;
  let currentStepId: string | null = steps.length > 0 ? steps[0].id : null;
  let finalStatus: DryRunResult["finalStatus"] = "complete";
```

to:

```ts
  const model = await getModel(workspaceId);
  const context: Record<string, unknown> = {};
  const trace: DryRunTraceEntry[] = [];
  const MAX_ITERATIONS = 50;
  let iterations = 0;
  let currentStepId: string | null = steps.length > 0 ? steps[0].id : null;
  let finalStatus: DryRunResult["finalStatus"] = "complete";
  let currentEmailContent = emailContent;
  let followUpConsumed = false;
```

In the `extract` case, change:

```ts
        const prompt =
          `Extract the following variables from this email. Return JSON with the variable names as keys and null for missing values.\nVariables: ${
            extractStep.variables.join(", ")
          }\n\nEmail:\n${emailContent}`;
        let extracted: Record<string, unknown> = {};
        let aiResponse = "";
        try {
          aiResponse = await chatCompletion(
            [{ role: "user", content: prompt }],
            "gpt-4o",
            { type: "json_object" },
          );
```

to:

```ts
        const prompt =
          `Extract the following variables from this email. Return JSON with the variable names as keys and null for missing values.\nVariables: ${
            extractStep.variables.join(", ")
          }\n\nEmail:\n${currentEmailContent}`;
        let extracted: Record<string, unknown> = {};
        let aiResponse = "";
        try {
          aiResponse = await chatCompletion(
            [{ role: "user", content: prompt }],
            model,
            { type: "json_object" },
          );
```

In the `ask_customer` case, change:

```ts
      case "ask_customer": {
        const askStep = step as AskCustomerStep;
        const message = askStep.message
          ? interpolate(typeof askStep.message === "string" ? askStep.message : "", context)
          : `[AI would ask for: ${(askStep.required_context ?? []).join(", ")} - goal: ${
            askStep.goal ?? "gather info"
          }]`;
        trace.push({
          stepId: step.id,
          stepType: step.type,
          status: "paused",
          summary: askStep.goal
            ? `Would AI-write question to gather: ${(askStep.required_context ?? []).join(", ")}`
            : "Would send question and wait for customer reply",
          messageSent: message,
        });
        finalStatus = "waiting_for_customer";
        currentStepId = null;
        break;
      }
```

to:

```ts
      case "ask_customer": {
        const askStep = step as AskCustomerStep;
        const message = askStep.message
          ? interpolate(typeof askStep.message === "string" ? askStep.message : "", context)
          : `[AI would ask for: ${(askStep.required_context ?? []).join(", ")} - goal: ${
            askStep.goal ?? "gather info"
          }]`;

        const followUp = resolveSimulatedFollowUp(
          askStep,
          currentEmailContent,
          followUpMessage,
          followUpConsumed,
        );
        if (followUp.consumed) {
          followUpConsumed = true;
          currentEmailContent = followUp.nextEmailContent;
          trace.push({
            stepId: step.id,
            stepType: step.type,
            status: "success",
            summary: `Simulated customer reply received, resuming at ${followUp.nextStepId}`,
            messageSent: message,
          });
          currentStepId = followUp.nextStepId;
          break;
        }

        trace.push({
          stepId: step.id,
          stepType: step.type,
          status: "paused",
          summary: askStep.goal
            ? `Would AI-write question to gather: ${(askStep.required_context ?? []).join(", ")}`
            : "Would send question and wait for customer reply",
          messageSent: message,
        });
        finalStatus = "waiting_for_customer";
        currentStepId = null;
        break;
      }
```

In the `triage` case, change:

```ts
        const prompt = `Choose the best route for this email thread.

GOAL:
${triageStep.goal}

ROUTES:
${routeLines}

EMAIL:
${emailContent}

Return JSON only with route, confidence, and reasoning.`;
        let aiResponse = "";
        try {
          aiResponse = await chatCompletion(
            [{ role: "user", content: prompt }],
            "gpt-4o",
            { type: "json_object" },
          );
```

to:

```ts
        const prompt = `Choose the best route for this email thread.

GOAL:
${triageStep.goal}

ROUTES:
${routeLines}

EMAIL:
${currentEmailContent}

Return JSON only with route, confidence, and reasoning.`;
        let aiResponse = "";
        try {
          aiResponse = await chatCompletion(
            [{ role: "user", content: prompt }],
            model,
            { type: "json_object" },
          );
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `cd api && deno test --allow-net --allow-env --allow-read services/playbook/dry-run_test.ts`
Expected: `ok | 3 passed | 0 failed`.

- [ ] **Step 5: Use `getModel` in `parser.ts`**

In `api/services/playbook/parser.ts`, change the import from:

```ts
import { chatCompletion } from "../ai.ts";
```

to:

```ts
import { chatCompletion, getModel } from "../ai.ts";
```

In `parsePlaybook`, change:

```ts
  const content = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Convert this to steps:\n\n${description}` },
    ],
    "gpt-4o",
    { type: "json_object" },
  );
```

to:

```ts
  const model = await getModel(workspaceId);
  const content = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Convert this to steps:\n\n${description}` },
    ],
    model,
    { type: "json_object" },
  );
```

In `parsePlaybookStep`, change:

```ts
  const content = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Generate a single step for: ${description}` },
    ],
    "gpt-4o",
    { type: "json_object" },
  );
```

to:

```ts
  const model = await getModel(workspaceId);
  const content = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Generate a single step for: ${description}` },
    ],
    model,
    { type: "json_object" },
  );
```

- [ ] **Step 6: Accept `follow_up_message` on the dry-run route**

In `api/routes/playbooks.ts`, change:

```ts
// POST /playbooks/:id/dry-run
playbooksRouter.post("/:id/dry-run", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid playbook ID");

  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const body = await c.req.json<{ email_content: string }>();

  if (!body.email_content || typeof body.email_content !== "string") {
    throw new AppError(422, "email_content is required");
  }

  const result = await dryRunPlaybook(id, body.email_content.trim(), workspaceId);
  return c.json(result);
});
```

to:

```ts
// POST /playbooks/:id/dry-run
playbooksRouter.post("/:id/dry-run", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid playbook ID");

  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const body = await c.req.json<{ email_content: string; follow_up_message?: string }>();

  if (!body.email_content || typeof body.email_content !== "string") {
    throw new AppError(422, "email_content is required");
  }

  const followUpMessage =
    typeof body.follow_up_message === "string" && body.follow_up_message.trim()
      ? body.follow_up_message.trim()
      : undefined;

  const result = await dryRunPlaybook(id, body.email_content.trim(), workspaceId, followUpMessage);
  return c.json(result);
});
```

- [ ] **Step 7: Extend `playbooksApi.dryRun` in `frontend/src/lib/api.ts`**

Change:

```ts
        dryRun(id: number, emailContent: string, workspaceId = 1) {
                return request<DryRunResult>(`/playbooks/${id}/dry-run?workspace_id=${workspaceId}`, {
                        method: 'POST',
                        body: JSON.stringify({ email_content: emailContent })
                });
        },
```

to:

```ts
        dryRun(id: number, emailContent: string, workspaceId = 1, followUpMessage?: string) {
                return request<DryRunResult>(`/playbooks/${id}/dry-run?workspace_id=${workspaceId}`, {
                        method: 'POST',
                        body: JSON.stringify({
                                email_content: emailContent,
                                ...(followUpMessage ? { follow_up_message: followUpMessage } : {})
                        })
                });
        },
```

This is backward compatible; the existing call site in `frontend/src/routes/playbooks/[id]/+page.svelte` (`playbooksApi.dryRun(playbookId, dryRunEmail.trim())`) keeps working unchanged.

- [ ] **Step 8: Run backend and frontend checks**

Run: `cd api && deno check main.ts`
Expected: no type errors.

Run: `cd api && deno test --allow-net --allow-env --allow-read`
Expected: all tests pass, including the 3 new `dry-run_test.ts` cases.

Run: `cd frontend && npm run check`
Expected: `0 errors`.

- [ ] **Step 9: Replace the stale known-issues section in `CLAUDE.md`**

Change:

```markdown
## Known issues to be aware of

- The evaluate handler only passes `required_context` variables to the AI, not the full context bag. This causes wrong decisions. Needs fixing.
- The playbook design guide may over-generate sheet-integration steps for simple conversational flows. Needs the "complexity should match the description" principle added.
- Escalation steps have hardcoded reason strings that don't reflect the actual cause of escalation (e.g. says "Could not find order" when the real cause was human rejection).
- Some old playbooks (v1, v2) still use legacy step shapes (literal `message` in ask_customer, `branch` instead of `evaluate`). New playbooks should use the new shapes.
```

to (write this text verbatim):

```markdown
## Known issues to be aware of

- Some old playbooks (v1, v2) still use legacy step shapes (literal `message` in ask_customer, `branch` instead of `evaluate`). New playbooks should use the new shapes.
- Shopify Admin API order lookups are not implemented; order data still comes from Google Sheets only. A future `find_order` step can write into `threads.brief.facts` the same way `find_sheet_row` does today.
- The sheet-rules system (`/sheet-rules`, `/sheet-updates`) has not been migrated into playbooks yet. It still runs as a separate primitive alongside the playbook engine.
- `categories.name` has no per-workspace unique constraint. This is a latent multi-tenant bug, harmless today because the app runs single-tenant.
- Customer attachments are marked in the transcript (`[attachment: filename]`) but their content is not read or understood by the AI.
```

- [ ] **Step 10: Update `docs/PLAYBOOK_ENGINE.md`: add `triage` to the step types table**

Change the table row for `evaluate` and the following row for `manual_approval` from:

```markdown
| `evaluate` | AI-driven three-way routing. Use when the decision requires judgment: "do we have enough info?", "is the conversation stuck?". | `goal: string, required_context: string[], if_satisfied_goto: string, if_missing_goto: string, if_escalate_goto: string` | advance to chosen step |
| `manual_approval` | Hold for human. Captures free-text input (e.g. Stripe transaction ID) when `capture_input: true`. | `reason: string, capture_input?: boolean, input_prompt?: string, input_context_key?: string, on_approve: string, on_reject: string` | pause(waiting_for_human) |
```

to:

```markdown
| `evaluate` | AI-driven three-way routing. Use when the decision requires judgment: "do we have enough info?", "is the conversation stuck?". | `goal: string, required_context: string[], if_satisfied_goto: string, if_missing_goto: string, if_escalate_goto: string` | advance to chosen step |
| `triage` | AI-driven route selection for intent/actionability decisions ("is this worth replying to?", "which workflow applies?"). Distinct from `evaluate`, which is a variable-presence gate rather than an intent router. | `goal: string, routes: [{label, description, goto}], fallback_goto: string, confidence_threshold?: number` | advance to the chosen route, or `fallback_goto` when unsure, invalid, or below threshold |
| `manual_approval` | Hold for human. Captures free-text input (e.g. Stripe transaction ID) when `capture_input: true`. | `reason: string, capture_input?: boolean, input_prompt?: string, input_context_key?: string, on_approve: string, on_reject: string` | pause(waiting_for_human) |
```

- [ ] **Step 11: Update `docs/PLAYBOOK_ENGINE.md`: remove the legacy auto-draft branch from the flow diagram**

Change:

```markdown
## Step execution flow

```
┌─────────────────────────────────────────┐
│  Inbound email arrives on thread T      │
└─────────────────┬───────────────────────┘
                  │
                  ▼
       ┌──────────────────┐
       │ Active run on T? │
       └────┬─────────┬───┘
            │ yes     │ no
            ▼         ▼
    ┌───────────┐  ┌──────────────┐
    │ Resume    │  │ Categorise   │
    │ run from  │  └──────┬───────┘
    │ current   │         ▼
    │ step      │  ┌────────────────┐
    └─────┬─────┘  │ Category has   │
          │        │ active playbook?│
          │        └────┬───────┬───┘
          │             │ yes   │ no
          │             ▼       ▼
          │      ┌──────────┐ ┌──────────────┐
          │      │ Create   │ │ Legacy:      │
          │      │ run, run │ │ categorise + │
          │      │ from     │ │ draft +      │
          │      │ step 1   │ │ auto-reply   │
          │      └────┬─────┘ └──────────────┘
          │           │
          ▼           ▼
       ┌───────────────────────┐
       │ Step executor loop:   │
       │ - load step           │
       │ - run handler         │
       │ - apply decision      │
       │ - persist execution   │
       │ - if 'advance', loop  │
       │ - if 'pause', stop    │
       │ - if 'complete', stop │
       │ - if 'fail', escalate │
       └───────────────────────┘
```
```

to:

```markdown
## Step execution flow

```
┌─────────────────────────────────────────┐
│  Inbound email arrives on thread T      │
└─────────────────┬───────────────────────┘
                  │
                  ▼
       ┌──────────────────┐
       │ Active run on T? │
       └────┬─────────┬───┘
            │ yes     │ no
            ▼         ▼
    ┌───────────┐  ┌──────────────┐
    │ Resume    │  │ Categorise   │
    │ run from  │  └──────┬───────┘
    │ current   │         ▼
    │ step      │  ┌────────────────┐
    └─────┬─────┘  │ Category has   │
          │        │ active playbook?│
          │        └────┬───────┬───┘
          │             │ yes   │ no
          │             ▼       ▼
          │      ┌──────────┐ ┌────────────────┐
          │      │ Create   │ │ Place thread    │
          │      │ run, run │ │ in_review for   │
          │      │ from     │ │ manual triage   │
          │      │ step 1   │ └────────────────┘
          │      └────┬─────┘
          │           │
          ▼           ▼
       ┌───────────────────────┐
       │ Step executor loop:   │
       │ - load step           │
       │ - run handler         │
       │ - apply decision      │
       │ - persist execution   │
       │ - if 'advance', loop  │
       │ - if 'pause', stop    │
       │ - if 'complete', stop │
       │ - if 'fail', escalate │
       └───────────────────────┘
```

Note: "Place thread in_review for manual triage" is a terminal state for that path, there is no run to hand off to the step executor loop, since no playbook exists for the category. This replaces the removed legacy behaviour, which used to auto-generate a draft in the now-retired `drafts` table.
```

- [ ] **Step 12: Add the new top entry to `docs/TASK_LOG.md`**

Insert this entry immediately after the `---` separator that follows the "Format" section, above the existing `## 2026-05-24 - Production Google OAuth invalid_grant incident` entry (write this verbatim):

```markdown
## 2026-07-20 - Product layer: review queue as home, human-looking replies, trust ramp

**Problem:** `/review`, `/sheet-rules`, and `/sheet-updates` had no navigation links, so the purpose-built approval and manual-reply queue was undiscoverable. The dashboard ran two parallel draft models (the legacy `drafts` table and playbook pending-sends), outbound mail had no display name or consistent signature, and every category stayed on manual draft-only forever with no path to auto-send.

**Changes made:**
- `frontend/src/routes/+layout.svelte`: added a "Review" nav entry before "Playbooks" with a live badge (`attentionCountStore`). `/system` links to `/sheet-updates` and `/sheet-rules`.
- `frontend/src/routes/review/+page.svelte` and `frontend/src/lib/components/ManualActionBanner.svelte`: subscribed the review queue to the workspace SSE channel, added a conflict-guard message when a run was already actioned elsewhere (409), added a "customer replied since this draft" notice with a one-click regenerate-draft action.
- Retired the legacy `drafts` table flow from the UI (`threads/[id]/+page.svelte`, `review/+page.svelte`). `ManualReplyPanel` and playbook pending-sends are the single draft model everywhere now. `GET/PATCH /threads/:id/drafts*` return 410 Gone; the `drafts` table itself is untouched pending a prod check for pending rows. Removed the dead `skipIfPendingDraft` guard from `categorisation.ts`.
- `api/services/gmail.ts`: outbound mail now sends `From: "Store Name" <address>` (falls back to the bare address when unset) and deterministically appends the configured signature once, to both playbook sends and manual replies. Inbound attachments are marked in the stored transcript as `[attachment: filename]`.
- `api/services/playbook/trust-ramp.ts`: new `recordApprovalOutcome()` tracks a per-playbook approval streak. A clean, unedited approval increments it; an edit or rejection resets it; reaching `auto_send_streak_target` flips `reply_mode` to `auto_reply` and announces graduation over SSE and the alert webhook. `revertToDraftOnly()` powers a one-click revert from the playbooks list.
- `api/services/playbook/dry-run.ts` and `parser.ts`: use `getModel(workspaceId)` instead of a hardcoded `gpt-4o`. Dry-run accepts an optional `followUpMessage` to simulate a mid-run customer reply and exercise the resume path.
- `docs/PLAYBOOK_ENGINE.md`: added the `triage` step to the step types table and removed the deleted legacy auto-draft branch from the flow diagram. `CLAUDE.md` known-issues list replaced with the current, verified set.

**Validation:**
- `deno test --allow-net --allow-env --allow-read` in `api/`: all tests pass, including new `gmail_test.ts`, `trust-ramp_test.ts`, and `dry-run_test.ts`.
- `deno check main.ts` passes.
- `npm run check` in `frontend/` passes with 0 errors.
- Playwright MCP: confirmed the Review nav entry, badge, conflict-guard message, regenerate-draft action, streak progress display, and graduation banner all render and behave as expected against a local run.
- `postgres` MCP: confirmed `playbooks.approval_streak` and `reply_mode` update correctly through a manual approve/edit/reject cycle.
```

- [ ] **Step 13: Commit**

```bash
git add api/services/playbook/dry-run.ts api/services/playbook/dry-run_test.ts api/services/playbook/parser.ts api/routes/playbooks.ts frontend/src/lib/api.ts CLAUDE.md docs/PLAYBOOK_ENGINE.md docs/TASK_LOG.md
git commit -m "Use configured model in dry-run and parser, support simulated follow-up, true up docs"
```

---

## Self-Review

**Spec coverage:** Section 3.3 bullet "Review queue as the manual-reply home" is covered by Task 9 (nav, badge, SSE, 409 guard, stale-draft notice) and Task 10 (one draft model, legacy endpoint retirement). "Human-looking replies" is covered by Task 11 (From header, signature, attachment markers). "Trust ramp" is covered by Task 12 (streak tracking, graduation, revert). Section 4's ramp fields (`auto_send_streak_target`, `approval_streak`) are consumed (not re-created) in Task 12, matching the instruction that migration 028 is already applied by an earlier phase. Section 9's three documentation items (`CLAUDE.md`, `docs/PLAYBOOK_ENGINE.md`, `docs/TASK_LOG.md`) are all covered in Task 13.

**Placeholder scan:** No "TBD", "add appropriate error handling", or "similar to Task N" phrasing appears in any step; every step that changes code shows the complete before/after code, and every doc-truth-up step shows the exact verbatim replacement text.

**Type consistency:** `recordApprovalOutcome(runId: number, outcome: "approved_clean" | "approved_edited" | "rejected"): Promise<{ graduated: boolean }>` is defined identically in the PRODUCED INTERFACES section and in Task 12 Step 4, and consumed with matching argument types in Task 12 Step 7. `dryRunPlaybook`'s 4th parameter `followUpMessage?: string` matches between Task 13 Steps 3, 6, and the PRODUCED INTERFACES section. `PlaybookRun.approval_streak?: number` / `auto_send_streak_target?: number` are added once in Task 12 Step 9 and read with the same optional-chaining pattern in Task 12 Steps 11 and 12. `formatFromHeader`, `appendSignature`, `appendAttachmentMarkers` signatures match between the Task 11 test file (Step 1) and implementation (Steps 4-5).

