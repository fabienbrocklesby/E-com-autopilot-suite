/**
 * Escalate handler — marks the run as escalated, flags for human review.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep, EscalateStep } from "../types.ts";

export const escalateHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const escalateStep = step as EscalateStep;
    console.log(`[playbook] escalate: run ${ctx.run.id} — ${escalateStep.reason}`);
    return {
      decision: { action: "fail", error: `Escalated: ${escalateStep.reason}` },
      output: { reason: escalateStep.reason },
    };
  },
};
