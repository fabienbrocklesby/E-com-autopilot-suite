/**
 * Retry worker — processes two queues:
 *
 * 1. Playbook runs in 'retrying' status whose next_retry_at has passed.
 *    Calls advanceRun() to resume. After MAX_RETRIES, escalates permanently.
 *
 * 2. Failed ingestions that haven't been resolved.
 *    Retries ingest up to 3 times then marks resolved with a "gave up" error.
 *
 * Runs every 5 minutes.
 */
import { query, execute } from "../../db/client.ts";
import { logger } from "../logger.ts";
import { sendAlert } from "../alerts.ts";
import { advanceRun } from "./executor.ts";
import { retryIngest } from "../gmail.ts";

const MAX_RETRIES = 5;
const MAX_INGESTION_ATTEMPTS = 3;

interface RetryRun {
  id: number;
  thread_id: number;
  workspace_id: number;
  retry_count: number;
}

interface FailedIngestion {
  id: number;
  workspace_id: number;
  gmail_message_id: string;
  gmail_thread_id: string;
  attempt_count: number;
}

async function processRetryRuns(): Promise<void> {
  const runs = await query<RetryRun>(
    `SELECT id, thread_id, workspace_id, retry_count
     FROM playbook_runs
     WHERE status = 'retrying'
       AND next_retry_at <= NOW()
       AND retry_count < $1`,
    [MAX_RETRIES],
  );

  for (const run of runs) {
    try {
      logger.info("retry_worker.advancing_run", { run_id: run.id, retry_count: run.retry_count });
      await advanceRun(run.id);
    } catch (err) {
      logger.error("retry_worker.advance_failed", { run_id: run.id, error: String(err) });

      // If retry_count has hit max, escalate
      if (run.retry_count >= MAX_RETRIES - 1) {
        await execute(
          `UPDATE playbook_runs SET status = 'escalated' WHERE id = $1`,
          [run.id],
        );
        await execute(
          "UPDATE threads SET status = 'in_review' WHERE id = $1",
          [run.thread_id],
        );
        await sendAlert(run.workspace_id, "run_escalated", {
          run_id: run.id,
          thread_id: run.thread_id,
          reason: `Exhausted ${MAX_RETRIES} retries`,
        }).catch(() => {});
      }
    }
  }
}

async function processFailedIngestions(): Promise<void> {
  const ingestions = await query<FailedIngestion>(
    `SELECT id, workspace_id, gmail_message_id, gmail_thread_id, attempt_count
     FROM failed_ingestions
     WHERE NOT resolved
       AND attempt_count < $1`,
    [MAX_INGESTION_ATTEMPTS],
  );

  for (const item of ingestions) {
    try {
      logger.info("retry_worker.retrying_ingestion", {
        id: item.id,
        gmail_message_id: item.gmail_message_id,
        attempt: item.attempt_count + 1,
      });

      await retryIngest(item.workspace_id, item.gmail_message_id, item.gmail_thread_id);

      // Success — mark resolved
      await execute(
        `UPDATE failed_ingestions SET resolved = true WHERE id = $1`,
        [item.id],
      );
      logger.info("retry_worker.ingestion_resolved", { id: item.id });
    } catch (err) {
      const newCount = item.attempt_count + 1;
      logger.warn("retry_worker.ingestion_retry_failed", {
        id: item.id,
        attempt: newCount,
        error: String(err),
      });

      if (newCount >= MAX_INGESTION_ATTEMPTS) {
        // Give up
        await execute(
          `UPDATE failed_ingestions
           SET attempt_count = $1, error = 'Gave up after ${MAX_INGESTION_ATTEMPTS} attempts',
               last_attempt_at = NOW(), resolved = true
           WHERE id = $2`,
          [newCount, item.id],
        );
        await sendAlert(item.workspace_id, "ingestion_failed_permanently", {
          gmail_message_id: item.gmail_message_id,
          gmail_thread_id: item.gmail_thread_id,
          attempts: newCount,
        }).catch(() => {});
      } else {
        await execute(
          `UPDATE failed_ingestions SET attempt_count = $1, error = $2, last_attempt_at = NOW() WHERE id = $3`,
          [newCount, String(err), item.id],
        );
      }
    }
  }
}

export function startRetryWorker(): void {
  const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  const tick = () => {
    Promise.all([processRetryRuns(), processFailedIngestions()]).catch((err) => {
      logger.error("retry_worker.error", { error: String(err) });
    });
  };

  tick(); // Run immediately on startup
  setInterval(tick, INTERVAL_MS);
  logger.info("retry_worker.started", { interval_minutes: 5 });
}
