/**
 * Integration test for processRetryRuns resuming a run whose next retry hits a
 * structural setup failure. Runs against a real Postgres database (no mocking
 * layer in this codebase); needs DATABASE_URL set. See test-helpers.ts.
 */
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { execute, queryOne } from "../../db/client.ts";
import type { EscalateStep } from "./types.ts";
import { processRetryRuns } from "./retry_worker.ts";
import { cleanupFixture, createTestFixture, createTestRun } from "./test-helpers.ts";

// sanitizeResources/Ops are disabled because these integration tests use the
// process-lifetime shared Postgres connection pool (db/client.ts), which Deno's
// leak detector would otherwise flag as an unclosed TCP connection.
Deno.test({
  name: "processRetryRuns surfaces a run whose retry hits a structural setup failure",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const steps: EscalateStep[] = [{ id: "step_1", type: "escalate", reason: "unused" }];
    // No OAuth token - advanceRun's loadRunSetup fails deterministically without
    // any network call. Since Task 7, advanceRun contains this itself via failRun
    // instead of throwing, so processRetryRuns's own catch-and-escalate fallback
    // is never reached here - the run still ends up terminal and visible either way.
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
      assertEquals(run!.status, "failed");
      assertExists(run!.context._failure_reason);

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
