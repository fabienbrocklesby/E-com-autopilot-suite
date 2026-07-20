/**
 * Integration test for processRetryRuns resuming a run whose next retry hits a
 * structural setup failure. Runs against a real Postgres database (no mocking
 * layer in this codebase); needs DATABASE_URL set. See test-helpers.ts.
 */
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { execute, queryOne } from "../../db/client.ts";
import type { EscalateStep } from "./types.ts";
import { processFailedIngestions, processRetryRuns } from "./retry_worker.ts";
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
