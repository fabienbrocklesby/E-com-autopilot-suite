/**
 * Route-level tests for the converged reject flows on POST /runs/:id/reject.
 * Runs against a real Postgres database (no mocking layer in this codebase)
 * and a real bearer-token-authed request through the actual router - needs
 * both DATABASE_URL and API_SECRET set. See test-helpers.ts.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { Hono } from "hono";
import { execute, queryOne } from "../db/client.ts";
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

// `async` here (rather than returning testApp.request(...) directly) matters:
// Hono's request() return type is `Response | Promise<Response>`, not
// `Promise<Response>`, so an async function body is needed for TS to wrap it.
async function authedRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return await testApp.request(path, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${API_SECRET}` },
  });
}

// sanitizeResources/Ops are disabled because these integration tests use the
// process-lifetime shared Postgres connection pool (db/client.ts), which Deno's
// leak detector would otherwise flag as an unclosed TCP connection.
Deno.test({
  name: "POST /runs/:id/reject on a pending send escalates with a human-rejection reason",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
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
      // ask_customer resolves a reply-to address off the thread's last inbound
      // message; createTestFixture creates the thread but no messages, so seed
      // one here (createTestFixture itself is shared by tests that don't need
      // this, so it stays generic and this test adds what it specifically needs).
      await execute(
        `INSERT INTO messages (thread_id, gmail_message_id, from_address, received_at, direction)
         VALUES ($1, $2, 'customer@example.com', NOW(), 'inbound')`,
        [fixture.threadId, `test-message-${fixture.threadId}`],
      );

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
  },
});

Deno.test({
  name: "POST /runs/:id/reject on a manual_approval step lands in the same terminal shape",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
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
  },
});

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
