/**
 * Complete handler — marks the run as complete.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep } from "../types.ts";

export const completeHandler: StepHandler = {
  async execute(_step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    console.log(`[playbook] complete: run ${ctx.run.id} finished successfully`);
    return {
      decision: { action: "complete" },
    };
  },
};
