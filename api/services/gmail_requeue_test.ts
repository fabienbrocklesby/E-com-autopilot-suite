/**
 * Integration test for requeuePendingSend - a customer message arriving while
 * a run is paused in waiting_to_send (a delayed send_reply). Runs against a
 * real Postgres database (no mocking layer in this codebase); needs
 * DATABASE_URL set. See ./playbook/test-helpers.ts.
 *
 * Uses a LITERAL message (no goal) so send_reply never calls the AI composer
 * (see handlers/send_reply.ts: hasLiteralMessage && !hasGoal skips composeReplyBody)
 * and, with delay_seconds > 0, always pauses to waiting_to_send. So the whole
 * requeue loop runs entirely against Postgres.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { execute, queryOne } from "../db/client.ts";
import type { PlaybookRun, SendReplyStep } from "./playbook/types.ts";
import { requeuePendingSend } from "./gmail.ts";
import { cleanupFixture, createTestFixture, createTestRun } from "./playbook/test-helpers.ts";

// sanitizeResources/Ops are disabled because these integration tests use the
// process-lifetime shared Postgres connection pool (db/client.ts), which Deno's
// leak detector would otherwise flag as an unclosed TCP connection.
Deno.test({
  name:
    "requeuePendingSend does not self-escalate a run after repeated customer follow-ups during one delayed send",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const steps: SendReplyStep[] = [
      {
        id: "send1",
        type: "send_reply",
        message: "Thanks, we will be in touch.",
        delay_seconds: 300,
      },
    ];
    const fixture = await createTestFixture(steps);
    try {
      // send_reply needs a last inbound message to resolve a reply-to address.
      await execute(
        `INSERT INTO messages (thread_id, gmail_message_id, from_address, body_plain, direction, received_at)
         VALUES ($1, $2, $3, $4, 'inbound', NOW())`,
        [
          fixture.threadId,
          `msg-${fixture.threadId}`,
          "customer@example.com",
          "Hi, I have a question.",
        ],
      );

      const runId = await createTestRun(fixture, steps, "send1", "waiting_to_send");

      // Simulate four rapid customer follow-ups landing while the delayed
      // send is pending. Each one requeues the run through the same
      // send_reply step - this must never look like a spin loop.
      for (let i = 0; i < 4; i++) {
        const run = await queryOne<PlaybookRun>(
          "SELECT * FROM playbook_runs WHERE id = $1",
          [runId],
        );
        await requeuePendingSend(run!);
      }

      const finalRun = await queryOne<{ status: string }>(
        "SELECT status FROM playbook_runs WHERE id = $1",
        [runId],
      );
      assertEquals(finalRun!.status, "waiting_to_send");

      const loopDetected = await queryOne<{ id: number }>(
        "SELECT id FROM playbook_step_executions WHERE run_id = $1 AND step_id = '_loop_detected'",
        [runId],
      );
      assertEquals(loopDetected, null);
    } finally {
      await cleanupFixture(fixture.workspaceId);
    }
  },
});
