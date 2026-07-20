/**
 * Playbook executor - the dispatch loop that advances a run through its steps.
 */
import { execute, query, queryOne, transaction } from "../../db/client.ts";
import { getHandler } from "./registry.ts";
import { logger } from "../logger.ts";
import { sendAlert } from "../alerts.ts";
import { AppError, type Message } from "../../types/index.ts";
import { publish } from "../event-bus.ts";
import { fetchThreadListItem } from "../../db/queries.ts";
import { getStoreProfile } from "../store-profile.ts";
import { getThreadBrief } from "./brief.ts";
import type {
  AskCustomerStep,
  Playbook,
  PlaybookRun,
  PlaybookStep,
  RunContext,
  RunStatus,
  StepExecution,
  StepResult,
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

export interface RunResult {
  runId: number;
  status: PlaybookRun["status"];
  currentStepId: string | null;
  context: Record<string, unknown>;
}

export function parsePlaybookSteps(
  source: PlaybookStep[] | string | null | undefined,
): PlaybookStep[] {
  if (!source) return [];
  return typeof source === "string" ? JSON.parse(source) : source;
}

export function getRunSteps(run: PlaybookRun, playbook: Playbook): PlaybookStep[] {
  return parsePlaybookSteps(run.steps_snapshot ?? playbook.steps);
}

/**
 * The single place status='escalated' gets written. Every escalation path -
 * loop detection, the 50-step cap, the escalate decision, human rejections,
 * and the timeout/retry workers - ends here, so every escalation looks
 * identical: real reason recorded, thread surfaced for review, alert fired,
 * SSE published. Exported so routes/playbooks.ts and the workers can call it
 * directly instead of re-implementing this by hand.
 *
 * The run UPDATE and the thread UPDATE are wrapped in one transaction() per
 * this repo's hard rule that multi-statement DB writes must be transactional -
 * see the tx.queryObject/queryArray pattern in human-reply.ts. The logging,
 * alert, and publish calls are side effects, not DB writes, so they run after
 * the transaction commits, outside it.
 */
export async function finalizeEscalation(
  runId: number,
  threadId: number,
  workspaceId: number,
  variables: Record<string, unknown>,
  currentStepId: string | null,
  reason: string,
): Promise<RunResult> {
  variables._escalation_reason = reason;

  const updatedRun = await transaction(async (tx) => {
    const runResult = await tx.queryObject<PlaybookRun & { playbook_name: string }>({
      text: `UPDATE playbook_runs pr
             SET status = 'escalated', current_step_id = $1, context = $2
             FROM playbooks p
             WHERE pr.playbook_id = p.id AND pr.id = $3
             RETURNING pr.*, p.name AS playbook_name`,
      args: [currentStepId, JSON.stringify(variables), runId],
    });
    await tx.queryArray("UPDATE threads SET status = 'in_review' WHERE id = $1", [threadId]);
    return runResult.rows[0] ?? null;
  });

  logger.error("playbook.run_escalated", { run_id: runId, thread_id: threadId, reason });
  await sendAlert(workspaceId, "run_escalated", { run_id: runId, thread_id: threadId, reason })
    .catch(() => {});
  if (updatedRun) {
    publish({ type: "run_updated", workspaceId, threadId, run: updatedRun });
  }
  const threadItem = await fetchThreadListItem(threadId, workspaceId);
  if (threadItem) {
    publish({
      type: "thread_updated",
      workspaceId,
      thread: threadItem as unknown as Record<string, unknown>,
    });
  }
  return { runId, status: "escalated", currentStepId, context: variables };
}

/**
 * Mark a run as escalated due to loop detection or the 50-execution cap.
 * Inserts a sentinel step execution record for visibility in the review
 * queue - there is no real step to attribute the escalation to.
 */
async function escalateRunDueToLoop(
  runId: number,
  threadId: number,
  workspaceId: number,
  variables: Record<string, unknown>,
  currentStepId: string | null,
  reason: string,
): Promise<RunResult> {
  await execute(
    `INSERT INTO playbook_step_executions (run_id, step_id, step_type, status, output, completed_at)
     VALUES ($1, '_loop_detected', '_loop_detected', 'failed', $2, NOW())`,
    [runId, JSON.stringify({ reason })],
  );
  return finalizeEscalation(runId, threadId, workspaceId, variables, currentStepId, reason);
}

export interface RunSetup {
  playbook: Playbook;
  steps: PlaybookStep[];
  thread: { id: number; gmail_thread_id: string; subject: string; workspace_id: number };
  messages: Message[];
  tokenRow: { email: string };
  senderName: string | null;
  storeProfile: string | null;
}

/**
 * Everything advanceRun needs besides the run row itself and the dynamic
 * per-iteration state (variables/currentStepId/status). Extracted so the
 * caller can wrap it in one try/catch (advanceRun) and so regenerate.ts
 * (Task 8) can build the same RunContext outside the run loop without
 * duplicating these seven queries.
 */
export async function loadRunSetup(run: PlaybookRun): Promise<RunSetup> {
  const playbook = await queryOne<Playbook>(
    "SELECT * FROM playbooks WHERE id = $1",
    [run.playbook_id],
  );
  if (!playbook) throw new Error(`Playbook ${run.playbook_id} not found`);

  const steps = getRunSteps(run, playbook);

  const thread = await queryOne<
    { id: number; gmail_thread_id: string; subject: string; workspace_id: number }
  >(
    "SELECT id, gmail_thread_id, subject, workspace_id FROM threads WHERE id = $1",
    [run.thread_id],
  );
  if (!thread) throw new Error(`Thread ${run.thread_id} not found`);

  // Full Message shape (Phase 1 widened this query to include thread_id and
  // gmail_message_id so RunContext.messages: Message[] is satisfied end to end).
  const messages = await query<Message>(
    "SELECT id, thread_id, gmail_message_id, from_address, body_plain, body_html, direction, received_at, message_id_header FROM messages WHERE thread_id = $1 ORDER BY received_at ASC",
    [run.thread_id],
  );

  const tokenRow = await queryOne<{ email: string }>(
    "SELECT email FROM oauth_tokens WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1",
    [run.workspace_id],
  );
  if (!tokenRow) throw new Error(`No OAuth token for workspace ${run.workspace_id}`);

  const senderNameRow = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE workspace_id = $1 AND key = 'sender_name'",
    [run.workspace_id],
  );
  const senderName = senderNameRow?.value ?? null;

  const storeProfile = await getStoreProfile(run.workspace_id);

  return { playbook, steps, thread, messages, tokenRow, senderName, storeProfile };
}

/** Pure - builds the per-step RunContext from a loaded setup plus the loop's
 *  dynamic state. No I/O, so both advanceRun's loop and regenerate.ts's
 *  one-shot context build (Task 8) can call it. */
export function buildRunContext(
  run: PlaybookRun,
  setup: RunSetup,
  variables: Record<string, unknown>,
  currentStepId: string | null,
  status: RunStatus,
): RunContext {
  return {
    run: { ...run, context: variables, current_step_id: currentStepId, status },
    playbook: { ...setup.playbook, steps: setup.steps },
    threadId: setup.thread.id,
    workspaceId: run.workspace_id,
    variables,
    messages: setup.messages,
    email: setup.tokenRow.email,
    gmailThreadId: setup.thread.gmail_thread_id,
    subject: setup.thread.subject,
    senderName: setup.senderName,
    storeProfile: setup.storeProfile,
  };
}

/**
 * The other terminal write path alongside finalizeEscalation: for genuine
 * structural failures (missing thread, no OAuth token, a playbook removed
 * out from under a run) rather than a deliberate escalation. Real reason
 * recorded, thread surfaced, alert fired, SSE published - so a run never
 * wedges in 'running' with nothing visible to a human.
 *
 * The run UPDATE and the thread UPDATE are wrapped in one transaction() per
 * this repo's hard rule that multi-statement DB writes must be transactional -
 * same tx.queryObject/queryArray pattern as finalizeEscalation. Unlike
 * finalizeEscalation, the run UPDATE is keyed by primary key only, not a JOIN
 * to playbooks: this path fires for a playbook that was deleted out from
 * under the run (loadRunSetup's "Playbook not found"), and a JOIN would then
 * match zero rows and leave the run wedged in 'running' - the exact case this
 * function exists to prevent. COALESCE guards a NULL context so
 * _failure_reason is never lost. The playbook name is fetched separately
 * after commit, tolerating a missing playbook, so the event still publishes.
 */
async function failRun(
  runId: number,
  threadId: number,
  workspaceId: number,
  reason: string,
): Promise<RunResult> {
  const updatedRun = await transaction(async (tx) => {
    const runResult = await tx.queryObject<PlaybookRun>({
      text: `UPDATE playbook_runs
             SET status = 'failed', context = COALESCE(context, '{}'::jsonb) || $1::jsonb
             WHERE id = $2
             RETURNING *`,
      args: [JSON.stringify({ _failure_reason: reason }), runId],
    });
    await tx.queryArray("UPDATE threads SET status = 'in_review' WHERE id = $1", [threadId]);
    return runResult.rows[0] ?? null;
  });

  logger.error("playbook.run_failed", { run_id: runId, thread_id: threadId, reason });
  await sendAlert(workspaceId, "run_failed", { run_id: runId, thread_id: threadId, reason })
    .catch(() => {});
  if (updatedRun) {
    // The playbook may be gone; tolerate a missing name rather than dropping
    // the event entirely.
    const playbookRow = await queryOne<{ name: string }>(
      "SELECT name FROM playbooks WHERE id = $1",
      [updatedRun.playbook_id],
    );
    publish({
      type: "run_updated",
      workspaceId,
      threadId,
      run: { ...updatedRun, playbook_name: playbookRow?.name ?? undefined },
    });
  }
  const threadItem = await fetchThreadListItem(threadId, workspaceId);
  if (threadItem) {
    publish({
      type: "thread_updated",
      workspaceId,
      thread: threadItem as unknown as Record<string, unknown>,
    });
  }
  const context = updatedRun
    ? (typeof updatedRun.context === "string" ? JSON.parse(updatedRun.context) : updatedRun.context)
    : {};
  return { runId, status: "failed", currentStepId: updatedRun?.current_step_id ?? null, context };
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

  // Everything else needed to execute a step can fail structurally - a
  // deleted thread, a disconnected Gmail account, a playbook removed out
  // from under a run. Contained here instead of propagating uncaught: the
  // run is marked failed with the real error, alerted, and the thread is
  // surfaced for review, instead of staying wedged in 'running' forever.
  let setup: RunSetup;
  try {
    setup = await loadRunSetup(run);
  } catch (err) {
    return await failRun(runId, run.thread_id, run.workspace_id, String(err));
  }
  const { steps } = setup;

  // Build context
  const variables: Record<string, unknown> = typeof run.context === "string"
    ? JSON.parse(run.context)
    : { ...run.context };

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
        run.workspace_id,
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
          run.workspace_id,
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
    const ctx: RunContext = buildRunContext(run, setup, variables, currentStepId, status);

    // Record step execution start
    const execRow = await queryOne<{ id: number }>(
      `INSERT INTO playbook_step_executions (run_id, step_id, step_type, status, input)
       VALUES ($1, $2, $3, 'running', $4) RETURNING id`,
      [runId, step.id, step.type, JSON.stringify(step)],
    );
    const execId = execRow!.id;

    publish({
      type: "step_execution_created",
      workspaceId: run.workspace_id,
      runId,
      threadId: run.thread_id,
      execution: {
        id: execId,
        run_id: runId,
        step_id: step.id,
        step_type: step.type,
        status: "running",
        input: step,
        output: null,
        error: null,
        ai_calls: null,
        created_at: new Date(),
        completed_at: null,
      },
    });

    let result: StepResult;
    try {
      result = await handler.execute(step, ctx);
    } catch (err) {
      // Mark step execution as failed
      await execute(
        "UPDATE playbook_step_executions SET status = 'failed', error = $1, completed_at = NOW() WHERE id = $2",
        [String(err), execId],
      );

      publish({
        type: "step_execution_updated",
        workspaceId: run.workspace_id,
        runId,
        threadId: run.thread_id,
        execution: {
          id: execId,
          run_id: runId,
          step_id: step.id,
          step_type: step.type,
          status: "failed",
          input: step,
          output: null,
          error: String(err),
          ai_calls: null,
          created_at: new Date(),
          completed_at: new Date(),
        },
      });

      // Check if this is a retriable transient error
      if (isRetriableError(err) && run.retry_count < MAX_RETRIES) {
        const delaySec = RETRY_DELAYS_SEC[Math.min(run.retry_count, RETRY_DELAYS_SEC.length - 1)];
        await execute(
          `UPDATE playbook_runs SET status = 'retrying', retry_count = retry_count + 1,
            next_retry_at = NOW() + ($1 || ' seconds')::interval WHERE id = $2`,
          [delaySec, runId],
        );
        publish({
          type: "run_updated",
          workspaceId: run.workspace_id,
          threadId: run.thread_id,
          run: {
            ...run,
            status: "retrying",
            current_step_id: currentStepId,
            context: variables,
            playbook_name: setup.playbook.name,
          },
        });
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
      publish({
        type: "run_updated",
        workspaceId: run.workspace_id,
        threadId: run.thread_id,
        run: {
          ...run,
          status: "failed",
          current_step_id: currentStepId,
          context: variables,
          playbook_name: setup.playbook.name,
        },
      });
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

    publish({
      type: "step_execution_updated",
      workspaceId: run.workspace_id,
      runId,
      threadId: run.thread_id,
      execution: {
        id: execId,
        run_id: runId,
        step_id: step.id,
        step_type: step.type,
        status: result.decision.action === "fail" ? "failed" : "success",
        input: step,
        output: result.output ?? null,
        error: null,
        ai_calls: result.aiCalls ?? null,
        created_at: new Date(),
        completed_at: new Date(),
      },
    });

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
        const sendAfter = result.decision.delaySec
          ? new Date(Date.now() + result.decision.delaySec * 1000)
          : null;
        // Persist and stop the loop; write send_after when delay is present
        await execute(
          "UPDATE playbook_runs SET status = $1, current_step_id = $2, context = $3, send_after = $4 WHERE id = $5",
          [status, currentStepId, JSON.stringify(variables), sendAfter, runId],
        );
        // Update thread status on pause so it surfaces in the inbox immediately
        if (
          status === "waiting_for_customer" ||
          status === "waiting_for_human" ||
          status === "waiting_to_send"
        ) {
          await execute("UPDATE threads SET status = 'in_review' WHERE id = $1", [run.thread_id]);
        }
        publish({
          type: "run_updated",
          workspaceId: run.workspace_id,
          threadId: run.thread_id,
          run: {
            ...run,
            status,
            current_step_id: currentStepId,
            context: variables,
            playbook_name: setup.playbook.name,
          },
        });
        const pausedThreadItem = await fetchThreadListItem(run.thread_id, run.workspace_id);
        if (pausedThreadItem) {
          publish({
            type: "thread_updated",
            workspaceId: run.workspace_id,
            thread: pausedThreadItem as unknown as Record<string, unknown>,
          });
        }
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
          publish({
            type: "run_updated",
            workspaceId: run.workspace_id,
            threadId: run.thread_id,
            run: {
              ...run,
              status: "retrying",
              current_step_id: currentStepId,
              context: variables,
              playbook_name: setup.playbook.name,
            },
          });
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

      case "escalate": {
        return await finalizeEscalation(
          runId,
          run.thread_id,
          run.workspace_id,
          variables,
          currentStepId,
          result.decision.reason,
        );
      }
    }

    // Persist run state after each step
    await execute(
      "UPDATE playbook_runs SET status = $1, current_step_id = $2, context = $3 WHERE id = $4",
      [status, currentStepId, JSON.stringify(variables), runId],
    );

    publish({
      type: "run_updated",
      workspaceId: run.workspace_id,
      threadId: run.thread_id,
      run: {
        ...run,
        status,
        current_step_id: currentStepId,
        context: variables,
        playbook_name: setup.playbook.name,
      },
    });

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
    await execute("UPDATE threads SET status = 'closed' WHERE id = $1", [run.thread_id]);
  } else if (status === "waiting_for_customer" || status === "waiting_for_human") {
    await execute("UPDATE threads SET status = 'in_review' WHERE id = $1", [run.thread_id]);
  } else if (status === "failed") {
    await execute("UPDATE threads SET status = 'in_review' WHERE id = $1", [run.thread_id]);
    await sendAlert(run.workspace_id, "run_failed", {
      run_id: runId,
      thread_id: run.thread_id,
    }).catch(() => {});
  }
  // retrying: don't change thread status - the run will resume automatically

  const threadItem = await fetchThreadListItem(run.thread_id, run.workspace_id);
  if (threadItem) {
    publish({
      type: "thread_updated",
      workspaceId: run.workspace_id,
      thread: threadItem as unknown as Record<string, unknown>,
    });
  }

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

  const steps = getRunSteps(run, playbook);

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
      // current_step_id was already advanced to on_reply_goto by the approve endpoint.
      // Run from the current position without skipping it.
      await execute(
        "UPDATE playbook_runs SET status = 'running', current_step_id = $1 WHERE id = $2",
        [run.current_step_id, runId],
      );
    }
  } else if (run.status === "waiting_for_human") {
    // For manual_approval, the approve/reject endpoints set current_step_id directly.
    // resumeRun should NOT be called for waiting_for_human runs - approval routing
    // is handled by POST /runs/:id/approve and /reject. If called anyway (e.g. by
    // mistake), log a warning and do nothing rather than advancing to the wrong step.
    logger.warn(
      "resumeRun called on waiting_for_human run - approval endpoints should handle this",
      {
        run_id: runId,
        current_step_id: run.current_step_id,
      },
    );
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

  const steps: PlaybookStep[] = typeof playbook.steps === "string"
    ? JSON.parse(playbook.steps)
    : playbook.steps;

  const firstStepId = steps.length > 0 ? steps[0].id : null;

  // Seed the run's context bag from the thread's brief facts. A thread that
  // gets a second run - recategorised, or the customer returns weeks later -
  // starts already knowing what an earlier run learned, instead of from '{}'.
  const brief = await getThreadBrief(threadId);

  const row = await queryOne<{ id: number }>(
    `INSERT INTO playbook_runs (workspace_id, thread_id, playbook_id, playbook_version, steps_snapshot, current_step_id, status, context)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'running', $7::jsonb)
     RETURNING id`,
    [
      workspaceId,
      threadId,
      playbookId,
      playbook.version,
      JSON.stringify(steps),
      firstStepId,
      JSON.stringify(brief.facts),
    ],
  );

  if (!row) throw new Error("Failed to create playbook run");

  logger.info("playbook.run_created", {
    run_id: row.id,
    thread_id: threadId,
    playbook_name: playbook.name,
    version: playbook.version,
  });
  return advanceRun(row.id);
}
