/**
 * Integration test for handleStartRunFailure. Runs against a real Postgres
 * database (no mocking layer in this codebase); needs DATABASE_URL set. See
 * playbook/test-helpers.ts.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { queryOne } from "../db/client.ts";
import { handleStartRunFailure } from "./categorisation.ts";
import { cleanupFixture, createTestFixture } from "./playbook/test-helpers.ts";

// sanitizeResources/Ops are disabled because these integration tests use the
// process-lifetime shared Postgres connection pool (db/client.ts), which Deno's
// leak detector would otherwise flag as an unclosed TCP connection.
Deno.test({
  name: "handleStartRunFailure surfaces the thread for review [DB]",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
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
  },
});
