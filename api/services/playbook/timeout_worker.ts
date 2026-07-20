/**
 * Timeout worker - escalates playbook runs that have been waiting for a customer
 * reply longer than the playbook's configured customer_silence_hours.
 * Runs every 30 minutes.
 */
import { query } from "../../db/client.ts";
import { logger } from "../logger.ts";
import { finalizeEscalation } from "./executor.ts";

interface SilentRun {
  id: number;
  thread_id: number;
  workspace_id: number;
  current_step_id: string | null;
  context: Record<string, unknown> | string;
  customer_silence_hours: number;
}

/** Exported for the timeout_worker_test.ts integration test - not meant to be
 *  called outside the worker's own tick except by tests. */
export async function checkSilentRuns(): Promise<void> {
  const runs = await query<SilentRun>(
    `SELECT r.id, r.thread_id, r.workspace_id, r.current_step_id, r.context, p.customer_silence_hours
     FROM playbook_runs r
     JOIN playbooks p ON p.id = r.playbook_id
     WHERE r.status = 'waiting_for_customer'
       AND r.updated_at < NOW() - (p.customer_silence_hours || ' hours')::interval`,
    [],
  );

  if (runs.length === 0) return;

  logger.info("timeout_worker.found_silent_runs", { count: runs.length });

  for (const run of runs) {
    const reason = `Customer silence timeout after ${run.customer_silence_hours} hours`;
    const variables = typeof run.context === "string"
      ? JSON.parse(run.context)
      : { ...run.context };

    await finalizeEscalation(
      run.id,
      run.thread_id,
      run.workspace_id,
      variables,
      run.current_step_id,
      reason,
    );
  }
}

export function startTimeoutWorker(): void {
  const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  const tick = () => {
    checkSilentRuns().catch((err) => {
      logger.error("timeout_worker.error", { error: String(err) });
    });
  };

  tick(); // Run immediately on startup
  setInterval(tick, INTERVAL_MS);
  logger.info("timeout_worker.started", { interval_minutes: 30 });
}
