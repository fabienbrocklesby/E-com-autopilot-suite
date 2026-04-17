/**
 * Escalate handler - marks the run as escalated, flags for human review.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep, EscalateStep } from "../types.ts";

export const escalateHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const escalateStep = step as EscalateStep;

    // If a manual_approval rejection set _rejection_source in context, use that
    // as the logged reason instead of the step's static config string. This
    // prevents "Could not find order in sheet" showing up when the real cause was
    // a human clicking Reject on an approval step.
    const rejectionSource = ctx.variables._rejection_source as string | undefined;
    const reason = rejectionSource
      ? `Rejected by human: ${rejectionSource}`
      : escalateStep.reason;

    console.log(`[playbook] escalate: run ${ctx.run.id} - ${reason}`);
    return {
      decision: { action: "fail", error: `Escalated: ${reason}` },
      output: { reason },
    };
  },
};
