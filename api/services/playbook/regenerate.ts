/**
 * Draft regeneration for stale waiting_for_human approvals. When a customer
 * replies while a draft is pending approval, the run stays paused (design
 * doc 3.2) and the message is attached via _messages_since_draft
 * (gmail.ts). This module re-runs the same composer the original step
 * used, with the current transcript, and replaces the pending draft in
 * place - no new step execution, no status change, just a fresher draft
 * for the same approval.
 */
import { queryOne, transaction } from "../../db/client.ts";
import { AppError } from "../../types/index.ts";
import { publish } from "../event-bus.ts";
import { buildRunContext, getRunSteps, loadRunSetup } from "./executor.ts";
import { composeAskDecision, composeReplyBody } from "./composer.ts";
import { isPresent } from "./context-utils.ts";
import type { AiCall } from "./composer.ts";
import type { Playbook, PlaybookRun, StepExecution } from "./types.ts";

/**
 * Replaces the pending draft on the run's current step execution,
 * appends the regeneration's aiCall onto that step execution's existing
 * ai_calls audit trail (a human looking at the review queue can see
 * every draft attempt, not just the latest), and clears
 * _messages_since_draft - the human is looking at a fresh draft now, the
 * stale flag no longer applies. Separated from regeneratePendingDraft so
 * the DB mutation is testable without invoking the composer/AI call.
 *
 * The run-context UPDATE and the step-execution UPDATE are wrapped in one
 * transaction() per this repo's hard rule that multi-statement DB writes
 * must be transactional - same tx.queryArray pattern finalizeEscalation and
 * failRun use in executor.ts. The publish call is a side effect, not a DB
 * write, so it runs after the transaction commits, outside it.
 */
export async function applyRegeneratedDraft(
  runId: number,
  threadId: number,
  workspaceId: number,
  body: string,
  aiCall: AiCall,
): Promise<void> {
  const run = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [runId]);
  if (!run) throw new AppError(404, "Run not found");

  const currentContext = typeof run.context === "string"
    ? JSON.parse(run.context)
    : { ...run.context };
  delete currentContext._messages_since_draft;

  await transaction(async (tx) => {
    await tx.queryArray(
      "UPDATE playbook_runs SET context = $1 WHERE id = $2",
      [JSON.stringify(currentContext), runId],
    );

    await tx.queryArray(
      `UPDATE playbook_step_executions
       SET output = output || jsonb_build_object('pending_send', $1::text),
           ai_calls = COALESCE(ai_calls, '[]'::jsonb) || jsonb_build_array($2::jsonb)
       WHERE id = (
         SELECT id FROM playbook_step_executions
         WHERE run_id = $3 AND step_id = $4
         ORDER BY created_at DESC LIMIT 1
       )`,
      [body, JSON.stringify(aiCall), runId, run.current_step_id],
    );
  });

  const updatedRun = await queryOne<PlaybookRun & { playbook_name: string }>(
    `SELECT pr.*, p.name AS playbook_name FROM playbook_runs pr JOIN playbooks p ON p.id = pr.playbook_id WHERE pr.id = $1`,
    [runId],
  );
  if (updatedRun) {
    publish({ type: "run_updated", workspaceId, threadId, run: updatedRun });
  }
}

/**
 * Re-runs the composer for a stale waiting_for_human draft and replaces
 * it. Only valid when the run is waiting_for_human with a genuine
 * pending send - the same validity check the approve/reject routes
 * already use. The route's external contract stays { body: string } -
 * the aiCall the composer returns is persisted as a side effect via
 * applyRegeneratedDraft, not handed back to the caller.
 */
export async function regeneratePendingDraft(runId: number): Promise<{ body: string }> {
  const run = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [runId]);
  if (!run) throw new AppError(404, "Run not found");
  if (run.status !== "waiting_for_human") {
    throw new AppError(409, `Run is not waiting_for_human (status: ${run.status})`);
  }

  const playbook = await queryOne<Playbook>(
    "SELECT * FROM playbooks WHERE id = $1",
    [run.playbook_id],
  );
  if (!playbook) throw new AppError(404, "Playbook not found");

  const steps = getRunSteps(run, playbook);
  const currentStep = steps.find((s) => s.id === run.current_step_id);
  if (
    !currentStep ||
    (currentStep.type !== "ask_customer" && currentStep.type !== "send_reply")
  ) {
    throw new AppError(409, "Run has no pending send to regenerate");
  }

  const lastExec = await queryOne<StepExecution>(
    `SELECT * FROM playbook_step_executions WHERE run_id = $1 AND step_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [runId, currentStep.id],
  );
  const output = typeof lastExec?.output === "string"
    ? JSON.parse(lastExec.output as string)
    : (lastExec?.output as Record<string, unknown> | null);
  if (output?.action !== "pending_approval" || typeof output.pending_send !== "string") {
    throw new AppError(409, "Run has no pending send to regenerate");
  }
  const pendingSend = output.pending_send as string; // guarded above: typeof === "string"

  const setup = await loadRunSetup(run);
  const variables = typeof run.context === "string" ? JSON.parse(run.context) : { ...run.context };
  const ctx = buildRunContext(run, setup, variables, run.current_step_id, run.status);

  const voice = currentStep.voice_hint ?? (playbook.writing_style || "friendly and professional");

  let body: string;
  let aiCall: AiCall;
  if (currentStep.type === "send_reply") {
    const referenceContext: Record<string, unknown> = {};
    for (const key of currentStep.reference_context ?? []) {
      if (isPresent(variables[key])) referenceContext[key] = variables[key];
    }
    const composed = await composeReplyBody({
      ctx,
      goal: currentStep.goal ??
        "Write a helpful and contextual reply to close out this interaction",
      voice,
      requiredContext: [],
      priorSent: [],
      referenceContext,
    });
    body = composed.body;
    aiCall = composed.aiCall;
  } else {
    const composed = await composeAskDecision({
      ctx,
      goal: currentStep.goal ?? "",
      voice,
      requiredContext: currentStep.required_context ?? [],
      priorSent: [pendingSend],
    });
    if (composed.decision.action !== "ask" || !composed.decision.message) {
      throw new AppError(
        409,
        `Composer could not draft a message from the current transcript (AI now recommends: ${composed.decision.action}). Handle this run manually instead of regenerating.`,
      );
    }
    body = composed.decision.message;
    aiCall = composed.aiCall;
  }

  await applyRegeneratedDraft(runId, run.thread_id, run.workspace_id, body, aiCall);
  return { body };
}
