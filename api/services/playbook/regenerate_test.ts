import { assertEquals, assertInstanceOf } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { execute, queryOne } from "../../db/client.ts";
import { startRun } from "./executor.ts";
import { AppError } from "../../types/index.ts";
import type { AskCustomerStep, CompleteStep, PlaybookStep } from "./types.ts";
import type { AiCall } from "./composer.ts";
import { applyRegeneratedDraft, regeneratePendingDraft } from "./regenerate.ts";
import { cleanupFixture, createTestFixture } from "./test-helpers.ts";

// sanitizeResources/Ops are disabled because these integration tests use the
// process-lifetime shared Postgres connection pool (db/client.ts), which Deno's
// leak detector would otherwise flag as an unclosed TCP connection.
Deno.test({
  name:
    "applyRegeneratedDraft replaces the pending draft, records the aiCall, and clears _messages_since_draft [DB]",
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
      // one here (same pattern as the reject-flow route tests in playbooks_test.ts).
      await execute(
        `INSERT INTO messages (thread_id, gmail_message_id, from_address, received_at, direction)
         VALUES ($1, $2, 'customer@example.com', NOW(), 'inbound')`,
        [fixture.threadId, `test-message-${fixture.threadId}`],
      );

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
  },
});

Deno.test({
  name: "regeneratePendingDraft rejects when the run is not waiting_for_human [DB]",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
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
  },
});
