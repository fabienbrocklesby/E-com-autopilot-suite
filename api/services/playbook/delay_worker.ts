/**
 * Delay worker - processes runs in 'waiting_to_send' status whose send_after has passed.
 *
 * When a send_reply step has delay_seconds > 0, the run is paused as waiting_to_send
 * with send_after set to NOW() + delay_seconds. This worker polls every minute, fires
 * the pending send via sendApprovedReply, advances the cursor to the next step,
 * and resumes the run.
 *
 * Runs every 60 seconds.
 */
import { query, execute } from "../../db/client.ts";
import { logger } from "../logger.ts";
import { sendApprovedReply } from "./approval-sender.ts";
import { advanceRun } from "./executor.ts";
import type { PlaybookRun } from "./types.ts";

interface DelayRun {
  id: number;
  thread_id: number;
  workspace_id: number;
  current_step_id: string | null;
  playbook_id: number;
}

interface StepExecRow {
  output: Record<string, unknown> | null;
}

interface PlaybookRow {
  steps: Array<{ id: string; type: string }>;
}

async function processDelayedSends(): Promise<void> {
  const runs = await query<DelayRun>(
    `SELECT id, thread_id, workspace_id, current_step_id, playbook_id
     FROM playbook_runs
     WHERE status = 'waiting_to_send'
       AND send_after <= NOW()`,
    [],
  );

  for (const run of runs) {
    try {
      if (!run.current_step_id) {
        logger.warn("delay_worker.no_current_step", { run_id: run.id });
        continue;
      }

      // Look up the pending_send body from the most recent step execution
      const execRow = await query<StepExecRow>(
        `SELECT output
         FROM playbook_step_executions
         WHERE run_id = $1 AND step_id = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [run.id, run.current_step_id],
      );

      const pending = execRow[0]?.output?.pending_send;
      if (typeof pending !== "string" || !pending) {
        logger.warn("delay_worker.no_pending_send_body", {
          run_id: run.id,
          step_id: run.current_step_id,
        });
        continue;
      }

      // Find the next step in the playbook so we advance past the send_reply step
      const playbookRows = await query<PlaybookRow>(
        "SELECT steps FROM playbooks WHERE id = $1",
        [run.playbook_id],
      );

      const steps = playbookRows[0]?.steps ?? [];
      const currentIdx = steps.findIndex((s) => s.id === run.current_step_id);
      const nextStep = currentIdx >= 0 ? steps[currentIdx + 1] : undefined;
      const nextStepId = nextStep?.id ?? null;

      logger.info("delay_worker.sending_delayed_reply", {
        run_id: run.id,
        thread_id: run.thread_id,
        next_step_id: nextStepId,
      });

      await sendApprovedReply(run as unknown as PlaybookRun, pending);

      // Advance cursor and clear send_after atomically BEFORE calling advanceRun
      // so the send_reply step is never re-executed and loop detection is not triggered
      await execute(
        `UPDATE playbook_runs
         SET status = 'running', current_step_id = $1, send_after = NULL
         WHERE id = $2`,
        [nextStepId, run.id],
      );

      if (nextStepId) {
        await advanceRun(run.id);
      } else {
        // No more steps after the reply - mark complete
        await execute(
          `UPDATE playbook_runs SET status = 'complete' WHERE id = $1`,
          [run.id],
        );
      }
    } catch (err) {
      // Log and continue - the run stays waiting_to_send and next tick will retry
      logger.error("delay_worker.send_failed", {
        run_id: run.id,
        thread_id: run.thread_id,
        error: String(err),
      });
    }
  }
}

export function startDelayWorker(): void {
  const INTERVAL_MS = 60_000; // 1 minute

  const tick = () => {
    processDelayedSends().catch((err) => {
      logger.error("delay_worker.error", { error: String(err) });
    });
  };

  tick(); // Run immediately on startup
  setInterval(tick, INTERVAL_MS);
  logger.info("delay_worker.started", { interval_minutes: 1 });
}
