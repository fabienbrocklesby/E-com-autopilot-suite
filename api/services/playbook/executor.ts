/**
 * Playbook executor - the dispatch loop that advances a run through its steps.
 */
import { query, queryOne, execute, transaction } from "../../db/client.ts";
import { getHandler } from "./registry.ts";
import { logger } from "../logger.ts";
import { sendAlert } from "../alerts.ts";
import { AppError } from "../../types/index.ts";
import type {
  Playbook,
  PlaybookRun,
  PlaybookStep,
  RunContext,
  StepResult,
  AskCustomerStep,
  StepExecution,
} from "./types.ts";

// Retry delay sequence in seconds: 5min, 15min, 30min, 1h, 2h
const RETRY_DELAYS_SEC = [300, 900, 1800, 3600, 7200];
const MAX_RETRIES = 5;

function isRetriableError(err: unknown): boolean {
  if (err instanceof AppError) {
    // Circuit breaker / AI unavailable
    if (err.statusCode === 503) return true;
    // Rate limit from any upstream API
    if (err.statusCode === 429) return true;
    // Gateway errors (OpenAI/Google transient)
    if (err.statusCode === 502) return true;
  }
  return false;
}

interface RunMessage {
  id: number;
  from_address: string;
  body_plain: string;
  direction: "inbound" | "outbound";
  received_at: Date;
  message_id_header: string | null;
}

export interface RunResult {
  runId: number;
  status: PlaybookRun["status"];
  currentStepId: string | null;
  context: Record<string, unknown>;
}

/**
 * Mark a run as escalated due to loop detection or other structural errors.
 * Inserts a sentinel step execution record for visibility in the review queue.
 */
async function escalateRunDueToLoop(
  runId: number,
  threadId: number,
  variables: Record<string, unknown>,
  currentStepId: string | null,
  reason: string,
): Promise<RunResult> {
  await execute(
    "UPDATE playbook_runs SET status = 'escalated', current_step_id = $1, context = $2 WHERE id = $3",
    [currentStepId, JSON.stringify(variables), runId],
  );
  await execute(
    `INSERT INTO playbook_step_executions (run_id, step_id, step_type, status, output, completed_at)
     VALUES ($1, '_loop_detected', '_loop_detected', 'failed', $2, NOW())`,
    [runId, JSON.stringify({ reason })],
  );
  await execute("UPDATE threads SET status = 'in_review' WHERE id = $1", [threadId]);
  logger.error("playbook.run_escalated", { run_id: runId, reason });
  await sendAlert(1, "run_escalated", { run_id: runId, thread_id: threadId, reason }).catch(() => {});
  return { runId, status: "escalated", currentStepId, context: variables };
}

/**
 * Advance a playbook run from its current step. Loops until the run pauses,
 * completes, or fails. All state changes are persisted per-step.
 */
export async function advanceRun(runId: number): Promise<RunResult> {
  // Load the run
  const run = await queryOne<PlaybookRun>(
    "SELECT * FROM playbook_runs WHERE id = $1",
    [runId],
  );
  if (!run) throw new Error(`Playbook run ${runId} not found`);

  // Load the playbook
  const playbook = await queryOne<Playbook>(
    "SELECT * FROM playbooks WHERE id = $1",
    [run.playbook_id],
  );
  if (!playbook) throw new Error(`Playbook ${run.playbook_id} not found`);

  // Parse steps from JSONB if needed
  const steps: PlaybookStep[] =
    typeof playbook.steps === "string" ? JSON.parse(playbook.steps) : playbook.steps;

  // Load the thread
  const thread = await queryOne<{ id: number; gmail_thread_id: string; subject: string; workspace_id: number }>(
    "SELECT id, gmail_thread_id, subject, workspace_id FROM threads WHERE id = $1",
    [run.thread_id],
  );
  if (!thread) throw new Error(`Thread ${run.thread_id} not found`);

  // Load messages
  const messages = await query<RunMessage>(
    "SELECT id, from_address, body_plain, direction, received_at, message_id_header FROM messages WHERE thread_id = $1 ORDER BY received_at ASC",
    [run.thread_id],
  );

  // Get connected email
  const tokenRow = await queryOne<{ email: string }>(
    "SELECT email FROM oauth_tokens WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1",
    [run.workspace_id],
  );
  if (!tokenRow) throw new Error(`No OAuth token for workspace ${run.workspace_id}`);

  // Load sender name from settings (used to sign replies)
  const senderNameRow = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE workspace_id = $1 AND key = 'sender_name'",
    [run.workspace_id],
  );
  const senderName = senderNameRow?.value ?? null;

  // Build context
  const variables: Record<string, unknown> =
    typeof run.context === "string" ? JSON.parse(run.context) : { ...run.context };

  let currentStepId = run.current_step_id;
  let status = run.status;
  // reset to running if this is a retry that was scheduled
  if (status === "retrying") status = "running";

  // If no current step, start at the first step
  if (!currentStepId && steps.length > 0) {
    currentStepId = steps[0].id;
  }

  // Safety: max iterations to prevent infinite loops
  const MAX_ITERATIONS = 50;
  let iterations = 0;

  while (currentStepId && iterations < MAX_ITERATIONS) {
    iterations++;

    // Loop detection: if this step has run 3+ times on this run, escalate
    const recentExecutions = await query<StepExecution>(
      `SELECT * FROM playbook_step_executions
       WHERE run_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [runId],
    );

    const sameStepCount = recentExecutions.filter((e) => e.step_id === currentStepId).length;
    if (sameStepCount >= 3) {
      return await escalateRunDueToLoop(
        runId,
        run.thread_id,
        variables,
        currentStepId,
        `Loop detected: step ${currentStepId} fired ${sameStepCount} times without progress`,
      );
    }

    if (recentExecutions.length > 0) {
      const totalRow = await queryOne<{ count: string }>(
        "SELECT COUNT(*) as count FROM playbook_step_executions WHERE run_id = $1",
        [runId],
      );
      if (parseInt(totalRow?.count ?? "0") > 50) {
        return await escalateRunDueToLoop(
          runId,
          run.thread_id,
          variables,
          currentStepId,
          "Exceeded 50 step executions, likely stuck in a loop",
        );
      }
    }

    const step = steps.find((s) => s.id === currentStepId);
    if (!step) {
      status = "failed";
      await execute(
        "UPDATE playbook_runs SET status = $1, current_step_id = $2, context = $3 WHERE id = $4",
        ["failed", currentStepId, JSON.stringify(variables), runId],
      );
  logger.error("playbook.step_not_found", { run_id: runId, step_id: currentStepId });
      break;
    }

    const handler = getHandler(step.type);

    // Build the run context for this step
    const ctx: RunContext = {
      run: { ...run, context: variables, current_step_id: currentStepId, status },
      playbook: { ...playbook, steps },
      threadId: thread.id,
      workspaceId: run.workspace_id,
      variables,
      messages,
      email: tokenRow.email,
      gmailThreadId: thread.gmail_thread_id,
      subject: thread.subject,
      senderName,
    };

    // Record step execution start
    const execRow = await queryOne<{ id: number }>(
      `INSERT INTO playbook_step_executions (run_id, step_id, step_type, status, input)
       VALUES ($1, $2, $3, 'running', $4) RETURNING id`,
      [runId, step.id, step.type, JSON.stringify(step)],
    );
    const execId = execRow!.id;

    let result: StepResult;
    try {
      result = await handler.execute(step, ctx);
    } catch (err) {
      // Mark step execution as failed
      await execute(
        "UPDATE playbook_step_executions SET status = 'failed', error = $1, completed_at = NOW() WHERE id = $2",
        [String(err), execId],
      );

      // Check if this is a retriable transient error
      if (isRetriableError(err) && run.retry_count < MAX_RETRIES) {
        const delaySec = RETRY_DELAYS_SEC[Math.min(run.retry_count, RETRY_DELAYS_SEC.length - 1)];
        await execute(
          `UPDATE playbook_runs SET status = 'retrying', retry_count = retry_count + 1,
            next_retry_at = NOW() + ($1 || ' seconds')::interval WHERE id = $2`,
          [delaySec, runId],
        );
        logger.warn("playbook.step_retry_scheduled", {
          run_id: runId,
          step_id: step.id,
          retry_count: run.retry_count + 1,
          delay_sec: delaySec,
          error: String(err),
        });
        status = "retrying";
        return { runId, status, currentStepId, context: variables };
      }

      // Non-retriable or exhausted retries - permanent failure
      status = "failed";
      await execute(
        "UPDATE playbook_runs SET status = 'failed', current_step_id = $1, context = $2 WHERE id = $3",
        [currentStepId, JSON.stringify(variables), runId],
      );
      logger.error("playbook.step_threw", { run_id: runId, step_id: step.id, error: String(err) });
      break;
    }

    // Apply context updates
    if (result.contextUpdates) {
      Object.assign(variables, result.contextUpdates);
    }

    // Record step execution result
    await execute(
      `UPDATE playbook_step_executions
       SET status = $1, output = $2, ai_calls = $3, completed_at = NOW()
       WHERE id = $4`,
      [
        result.decision.action === "fail" ? "failed" : "success",
        result.output ? JSON.stringify(result.output) : null,
        result.aiCalls ? JSON.stringify(result.aiCalls) : null,
        execId,
      ],
    );

    // Apply the decision
    switch (result.decision.action) {
      case "advance": {
        // Move to next step in sequence
        const currentIndex = steps.findIndex((s) => s.id === currentStepId);
        if (currentIndex < steps.length - 1) {
          currentStepId = steps[currentIndex + 1].id;
        } else {
          // No more steps - complete
          currentStepId = null;
          status = "complete";
        }
        break;
      }

      case "advance_to": {
        currentStepId = result.decision.stepId;
        break;
      }

      case "pause": {
        status = result.decision.status;
        // Persist and stop the loop
        await execute(
          "UPDATE playbook_runs SET status = $1, current_step_id = $2, context = $3 WHERE id = $4",
          [status, currentStepId, JSON.stringify(variables), runId],
        );
        logger.info("playbook.run_paused", { run_id: runId, step_id: currentStepId, status });
        return { runId, status, currentStepId, context: variables };
      }

      case "complete": {
        status = "complete";
        currentStepId = null;
        break;
      }

      case "fail": {
        // Check if this is a retriable failure from the step handler
        if (result.decision.retriable && run.retry_count < MAX_RETRIES) {
          const delaySec = RETRY_DELAYS_SEC[Math.min(run.retry_count, RETRY_DELAYS_SEC.length - 1)];
          await execute(
            `UPDATE playbook_runs SET status = 'retrying', retry_count = retry_count + 1,
              next_retry_at = NOW() + ($1 || ' seconds')::interval WHERE id = $2`,
            [delaySec, runId],
          );
          logger.warn("playbook.step_retry_scheduled", {
            run_id: runId,
            step_id: step.id,
            retry_count: run.retry_count + 1,
            delay_sec: delaySec,
            error: result.decision.error,
          });
          status = "retrying";
          return { runId, status, currentStepId, context: variables };
        }
        status = "failed";
        await execute(
          "UPDATE playbook_step_executions SET error = $1 WHERE id = $2",
          [result.decision.error, execId],
        );
        break;
      }
    }

    // Persist run state after each step
    await execute(
      "UPDATE playbook_runs SET status = $1, current_step_id = $2, context = $3 WHERE id = $4",
      [status, currentStepId, JSON.stringify(variables), runId],
    );

    // If run is no longer running, stop
    if (status !== "running") break;
  }

  if (iterations >= MAX_ITERATIONS) {
    logger.error("playbook.max_iterations", { run_id: runId, iterations: MAX_ITERATIONS });
    status = "failed";
    await execute(
      "UPDATE playbook_runs SET status = 'failed', context = $1 WHERE id = $2",
      [JSON.stringify(variables), runId],
    );
  }

  // Mark thread status based on run outcome
  if (status === "complete") {
    await execute("UPDATE threads SET status = 'replied' WHERE id = $1", [run.thread_id]);
  } else if (status === "waiting_for_customer" || status === "waiting_for_human") {
    await execute("UPDATE threads SET status = 'in_review' WHERE id = $1", [run.thread_id]);
  } else if (status === "escalated" || status === "failed") {
    await execute("UPDATE threads SET status = 'in_review' WHERE id = $1", [run.thread_id]);
    if (status === "escalated") {
      await sendAlert(run.workspace_id, "run_escalated", { run_id: runId, thread_id: run.thread_id }).catch(() => {});
    }
  }
  // retrying: don't change thread status - the run will resume automatically

  logger.info("playbook.run_finished", { run_id: runId, status });
  return { runId, status, currentStepId, context: variables };
}

/**
 * Resume a paused run. For waiting_for_customer runs, the ask_customer step's
 * on_reply_goto determines where to jump. For waiting_for_human runs, the
 * decision comes from the approval action.
 */
export async function resumeRun(runId: number): Promise<RunResult> {
  const run = await queryOne<PlaybookRun>(
    "SELECT * FROM playbook_runs WHERE id = $1",
    [runId],
  );
  if (!run) throw new Error(`Playbook run ${runId} not found`);

  const playbook = await queryOne<Playbook>(
    "SELECT * FROM playbooks WHERE id = $1",
    [run.playbook_id],
  );
  if (!playbook) throw new Error(`Playbook ${run.playbook_id} not found`);

  const steps: PlaybookStep[] =
    typeof playbook.steps === "string" ? JSON.parse(playbook.steps) : playbook.steps;

  if (run.status === "waiting_for_customer") {
    // Find the current ask_customer step to get on_reply_goto
    const currentStep = steps.find((s) => s.id === run.current_step_id);
    if (currentStep && currentStep.type === "ask_customer") {
      const askStep = currentStep as AskCustomerStep;
      // Update run to jump to the on_reply_goto step and set status back to running
      await execute(
        "UPDATE playbook_runs SET status = 'running', current_step_id = $1 WHERE id = $2",
        [askStep.on_reply_goto, runId],
      );
    } else {
      // Fallback: advance to next step in sequence
      const currentIndex = steps.findIndex((s) => s.id === run.current_step_id);
      const nextStep = currentIndex < steps.length - 1 ? steps[currentIndex + 1] : null;
      await execute(
        "UPDATE playbook_runs SET status = 'running', current_step_id = $1 WHERE id = $2",
        [nextStep?.id ?? null, runId],
      );
    }
  } else if (run.status === "waiting_for_human") {
    // For manual_approval, the approve/reject endpoints set current_step_id directly.
    // resumeRun should NOT be called for waiting_for_human runs - approval routing
    // is handled by POST /runs/:id/approve and /reject. If called anyway (e.g. by
    // mistake), log a warning and do nothing rather than advancing to the wrong step.
    logger.warn("resumeRun called on waiting_for_human run - approval endpoints should handle this", {
      run_id: runId,
      current_step_id: run.current_step_id,
    });
    const context = typeof run.context === "string" ? JSON.parse(run.context) : { ...run.context };
    return { runId, status: run.status, currentStepId: run.current_step_id, context };
  }

  return advanceRun(runId);
}

/**
 * Create a new playbook run for a thread and start executing it.
 */
export async function startRun(
  workspaceId: number,
  threadId: number,
  playbookId: number,
): Promise<RunResult> {
  const playbook = await queryOne<Playbook>(
    "SELECT * FROM playbooks WHERE id = $1",
    [playbookId],
  );
  if (!playbook) throw new Error(`Playbook ${playbookId} not found`);

  const steps: PlaybookStep[] =
    typeof playbook.steps === "string" ? JSON.parse(playbook.steps) : playbook.steps;

  const firstStepId = steps.length > 0 ? steps[0].id : null;

  const row = await queryOne<{ id: number }>(
    `INSERT INTO playbook_runs (workspace_id, thread_id, playbook_id, playbook_version, current_step_id, status, context)
     VALUES ($1, $2, $3, $4, $5, 'running', '{}')
     RETURNING id`,
    [workspaceId, threadId, playbookId, playbook.version, firstStepId],
  );

  if (!row) throw new Error("Failed to create playbook run");

  logger.info("playbook.run_created", { run_id: row.id, thread_id: threadId, playbook_name: playbook.name, version: playbook.version });
  return advanceRun(row.id);
}
