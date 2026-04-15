/**
 * System dashboard routes.
 * Exposes live stats for observability, circuit breaker state, and manual resets.
 */
import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { query, queryOne } from "../db/client.ts";
import { getCircuitBreakerState, resetCircuitBreaker } from "../services/ai.ts";

export const systemRouter = new Hono();
systemRouter.use("*", authMiddleware);

// GET /system/stats — live dashboard data
systemRouter.get("/stats", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");

  const [
    runsByStatus,
    escalatedLast24h,
    stepTimingStats,
    aiCallStats,
    failedIngestions,
    rateLimitBuckets,
  ] = await Promise.all([
    // Runs by status
    query<{ status: string; count: string }>(
      `SELECT status, COUNT(*) as count
       FROM playbook_runs
       WHERE workspace_id = $1
         AND status NOT IN ('complete', 'failed', 'escalated')
       GROUP BY status`,
      [workspaceId],
    ),

    // Runs escalated in last 24h
    queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM playbook_runs
       WHERE workspace_id = $1 AND status = 'escalated'
         AND updated_at > NOW() - interval '24 hours'`,
      [workspaceId],
    ),

    // Step execution timing
    query<{ window: string; avg_ms: number; p95_ms: number }>(
      `SELECT
         CASE WHEN completed_at > NOW() - interval '1 hour' THEN '1h' ELSE '24h' END as window,
         ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000))::int as avg_ms,
         ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000))::int as p95_ms
       FROM playbook_step_executions
       WHERE completed_at IS NOT NULL
         AND created_at > NOW() - interval '24 hours'
         AND run_id IN (SELECT id FROM playbook_runs WHERE workspace_id = $1)
       GROUP BY CASE WHEN completed_at > NOW() - interval '1 hour' THEN '1h' ELSE '24h' END`,
      [workspaceId],
    ),

    // AI calls from step executions (last 24h)
    queryOne<{ call_count: number; total_tokens: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE ai_calls IS NOT NULL)::int as call_count,
         COALESCE(SUM(
           (SELECT SUM((elem->>'tokens')::int)
            FROM jsonb_array_elements(ai_calls) AS elem
            WHERE elem->>'tokens' IS NOT NULL)
         ), 0)::int as total_tokens
       FROM playbook_step_executions
       WHERE created_at > NOW() - interval '24 hours'
         AND run_id IN (SELECT id FROM playbook_runs WHERE workspace_id = $1)`,
      [workspaceId],
    ),

    // Failed ingestions
    query<{ id: number; gmail_message_id: string; error: string; attempt_count: number; last_attempt_at: string }>(
      `SELECT id, gmail_message_id, error, attempt_count, last_attempt_at
       FROM failed_ingestions
       WHERE workspace_id = $1 AND NOT resolved
       ORDER BY created_at DESC
       LIMIT 20`,
      [workspaceId],
    ),

    // Rate limit bucket states
    query<{ api: string; tokens: number; calls_total: number; last_refilled_at: string }>(
      `SELECT api, tokens::float as tokens, calls_total::int as calls_total, last_refilled_at
       FROM rate_limit_buckets
       WHERE workspace_id = $1`,
      [workspaceId],
    ),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const row of runsByStatus) {
    statusCounts[row.status] = parseInt(row.count);
  }

  const timing: Record<string, { avg_ms: number; p95_ms: number }> = {};
  for (const row of stepTimingStats) {
    timing[row.window] = { avg_ms: row.avg_ms, p95_ms: row.p95_ms };
  }

  return c.json({
    active_runs: statusCounts,
    escalated_last_24h: parseInt(escalatedLast24h?.count ?? "0"),
    step_timing: timing,
    ai_calls_24h: {
      count: aiCallStats?.call_count ?? 0,
      total_tokens: aiCallStats?.total_tokens ?? 0,
    },
    failed_ingestions: {
      unresolved_count: failedIngestions.length,
      recent: failedIngestions,
    },
    // NUMERIC columns come back as strings from the postgres driver — parse explicitly
    rate_limit_buckets: rateLimitBuckets.map((b) => ({
      ...b,
      tokens: parseFloat(String(b.tokens)),
      calls_total: parseInt(String(b.calls_total), 10),
    })),
    circuit_breaker: getCircuitBreakerState(),
  });
});

// GET /system/failed-ingestions — paginated list
systemRouter.get("/failed-ingestions", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const showResolved = c.req.query("resolved") === "true";

  const rows = await query<{
    id: number;
    gmail_message_id: string;
    gmail_thread_id: string;
    error: string;
    attempt_count: number;
    last_attempt_at: string;
    resolved: boolean;
    created_at: string;
  }>(
    `SELECT id, gmail_message_id, gmail_thread_id, error, attempt_count,
            last_attempt_at, resolved, created_at
     FROM failed_ingestions
     WHERE workspace_id = $1 ${showResolved ? "" : "AND NOT resolved"}
     ORDER BY created_at DESC
     LIMIT 100`,
    [workspaceId],
  );

  return c.json({ ingestions: rows });
});

// POST /system/failed-ingestions/:id/retry — manual retry
systemRouter.post("/failed-ingestions/:id/retry", async (c) => {
  const id = parseInt(c.req.param("id"));
  const { retryIngest } = await import("../services/gmail.ts");

  const row = await queryOne<{
    id: number;
    workspace_id: number;
    gmail_message_id: string;
    gmail_thread_id: string;
  }>(
    "SELECT id, workspace_id, gmail_message_id, gmail_thread_id FROM failed_ingestions WHERE id = $1",
    [id],
  );
  if (!row) return c.json({ error: "Not found" }, 404);

  try {
    await retryIngest(row.workspace_id, row.gmail_message_id, row.gmail_thread_id);
    await import("../db/client.ts").then(({ execute }) =>
      execute("UPDATE failed_ingestions SET resolved = true WHERE id = $1", [id])
    );
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// GET /system/circuit-breaker
systemRouter.get("/circuit-breaker", (c) => {
  return c.json(getCircuitBreakerState());
});

// POST /system/circuit-breaker/reset — manual reset
systemRouter.post("/circuit-breaker/reset", (c) => {
  resetCircuitBreaker();
  return c.json({ ok: true, state: getCircuitBreakerState() });
});
