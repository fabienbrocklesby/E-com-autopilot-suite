/**
 * Timeout worker — escalates playbook runs that have been waiting for a customer
 * reply longer than the playbook's configured customer_silence_hours.
 * Runs every 30 minutes.
 */
import { query, execute } from "../../db/client.ts";
import { logger } from "../logger.ts";
import { sendAlert } from "../alerts.ts";

interface SilentRun {
  id: number;
  thread_id: number;
  workspace_id: number;
  customer_silence_hours: number;
}

async function checkSilentRuns(): Promise<void> {
  const runs = await query<SilentRun>(
    `SELECT r.id, r.thread_id, r.workspace_id, p.customer_silence_hours
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

    await execute(
      `UPDATE playbook_runs SET status = 'escalated' WHERE id = $1`,
      [run.id],
    );
    await execute(
      `INSERT INTO playbook_step_executions (run_id, step_id, step_type, status, output, completed_at)
       VALUES ($1, '_silence_timeout', '_silence_timeout', 'failed', $2, NOW())`,
      [run.id, JSON.stringify({ reason })],
    );
    await execute(
      "UPDATE threads SET status = 'in_review' WHERE id = $1",
      [run.thread_id],
    );

    logger.warn("timeout_worker.run_escalated", {
      run_id: run.id,
      thread_id: run.thread_id,
      workspace_id: run.workspace_id,
      silence_hours: run.customer_silence_hours,
    });

    await sendAlert(run.workspace_id, "run_escalated", {
      run_id: run.id,
      thread_id: run.thread_id,
      reason,
    }).catch(() => {});
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
