/**
 * Integration test for checkSilentRuns -> finalizeEscalation. Runs against a
 * real Postgres database (no mocking layer in this codebase); needs
 * DATABASE_URL set. See test-helpers.ts.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { execute, queryOne } from "../../db/client.ts";
import type { EscalateStep } from "./types.ts";
import { checkSilentRuns } from "./timeout_worker.ts";
import { cleanupFixture, createTestFixture, createTestRun } from "./test-helpers.ts";

// sanitizeResources/Ops are disabled because these integration tests use the
// process-lifetime shared Postgres connection pool (db/client.ts), which Deno's
// leak detector would otherwise flag as an unclosed TCP connection.
Deno.test({
  name: "checkSilentRuns escalates a run waiting past customer_silence_hours",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
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
  },
});
