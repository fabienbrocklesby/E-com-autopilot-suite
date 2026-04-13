/**
 * Manual approval handler — pauses the run for human review.
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
        on_approve: approvalStep.on_approve,
        on_reject: approvalStep.on_reject,
      },
    };
  },
};
