/**
 * Integration test for the escalate StepDecision -> status='escalated' mapping.
 * Runs against a real Postgres database (no mocking layer in this codebase);
 * needs DATABASE_URL set. See test-helpers.ts.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { advanceRun } from "./executor.ts";
import { cleanupFixture, createTestFixture, createTestRun } from "./test-helpers.ts";
import { queryOne } from "../../db/client.ts";
import type { PlaybookStep } from "./types.ts";

// sanitizeResources/Ops are disabled because these integration tests use the
// process-lifetime shared Postgres connection pool (db/client.ts), which Deno's
// leak detector would otherwise flag as an unclosed TCP connection.
Deno.test({
  name: "advanceRun maps an escalate step to status escalated with the real reason",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const steps = [
      { id: "esc1", type: "escalate", reason: "Test escalation cause" },
    ] as unknown as PlaybookStep[];

    const fixture = await createTestFixture(steps);
    try {
      const runId = await createTestRun(fixture, steps, "esc1", "running");
      await advanceRun(runId);

      const run = await queryOne<{ status: string; context: unknown }>(
        "SELECT status, context FROM playbook_runs WHERE id = $1",
        [runId],
      );
      assertEquals(run!.status, "escalated");

      const ctx = typeof run!.context === "string"
        ? JSON.parse(run!.context)
        : (run!.context as Record<string, unknown>);
      assertEquals(ctx._escalation_reason, "Test escalation cause");

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
