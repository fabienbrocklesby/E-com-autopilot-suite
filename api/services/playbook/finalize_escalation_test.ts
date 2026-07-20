/**
 * Integration test for finalizeEscalation, the shared helper both reject paths
 * (pending-send reject in routes/playbooks.ts and loop-detection escalation in
 * executor.ts) route through. Runs against a real Postgres database (no mocking
 * layer in this codebase); needs DATABASE_URL set. See test-helpers.ts.
 */
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { finalizeEscalation } from "./executor.ts";
import { cleanupFixture, createTestFixture, createTestRun } from "./test-helpers.ts";
import { queryOne } from "../../db/client.ts";
import type { PlaybookStep } from "./types.ts";

// sanitizeResources/Ops are disabled because these integration tests use the
// process-lifetime shared Postgres connection pool (db/client.ts), which Deno's
// leak detector would otherwise flag as an unclosed TCP connection.
Deno.test({
  name: "finalizeEscalation escalates a run, records the reason, and sets the thread in_review",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const steps = [
      { id: "send1", type: "send_reply", goal: "reply", require_approval: true },
    ] as unknown as PlaybookStep[];

    const fixture = await createTestFixture(steps);
    try {
      const runId = await createTestRun(fixture, steps, "send1", "waiting_for_human");

      await finalizeEscalation(
        runId,
        fixture.threadId,
        fixture.workspaceId,
        "Rejected by human: send1 (rejected send_reply)",
        { currentStepId: "send1" },
      );

      const run = await queryOne<{ status: string; context: unknown }>(
        "SELECT status, context FROM playbook_runs WHERE id = $1",
        [runId],
      );
      assertEquals(run!.status, "escalated");

      const ctx = typeof run!.context === "string"
        ? JSON.parse(run!.context)
        : (run!.context as Record<string, unknown>);
      assertEquals(ctx._escalation_reason, "Rejected by human: send1 (rejected send_reply)");

      const thread = await queryOne<{ status: string }>(
        "SELECT status FROM threads WHERE id = $1",
        [fixture.threadId],
      );
      assertEquals(thread!.status, "in_review");

      const sentinelExec = await queryOne<{ step_id: string; output: unknown }>(
        "SELECT step_id, output FROM playbook_step_executions WHERE run_id = $1 AND step_id = '_rejected'",
        [runId],
      );
      assertExists(sentinelExec);
      const output = typeof sentinelExec!.output === "string"
        ? JSON.parse(sentinelExec!.output)
        : (sentinelExec!.output as Record<string, unknown>);
      assertEquals(output.reason, "Rejected by human: send1 (rejected send_reply)");
    } finally {
      await cleanupFixture(fixture.workspaceId);
    }
  },
});
