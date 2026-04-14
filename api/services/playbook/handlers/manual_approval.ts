/**
 * Manual approval handler — pauses the run for human review.
 * Includes capture_input config in output so the review UI can render it.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep, ManualApprovalStep } from "../types.ts";

export const manualApprovalHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const approvalStep = step as ManualApprovalStep;
    console.log(`[playbook] manual_approval: run ${ctx.run.id} — ${approvalStep.reason}`);
    return {
      decision: { action: "pause", status: "waiting_for_human" },
      output: {
        reason: approvalStep.reason,
        capture_input: approvalStep.capture_input ?? false,
        input_prompt: approvalStep.input_prompt ?? null,
        input_context_key: approvalStep.input_context_key ?? "human_notes",
        on_approve: approvalStep.on_approve,
        on_reject: approvalStep.on_reject,
      },
    };
  },
};
