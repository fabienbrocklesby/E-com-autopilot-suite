/**
 * Integration test for the escalate StepDecision -> finalizeEscalation ->
 * status='escalated' path. Runs against a real Postgres database (no mocking
 * layer in this codebase); needs DATABASE_URL set. See test-helpers.ts.
 */
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { queryOne } from "../../db/client.ts";
import type { EscalateStep } from "./types.ts";
import { startRun } from "./executor.ts";
import { cleanupFixture, createTestFixture } from "./test-helpers.ts";

// sanitizeResources/Ops are disabled because these integration tests use the
// process-lifetime shared Postgres connection pool (db/client.ts), which Deno's
// leak detector would otherwise flag as an unclosed TCP connection.
Deno.test({
  name: "advanceRun maps an escalate decision to status escalated with the real reason",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
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
  },
});

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
