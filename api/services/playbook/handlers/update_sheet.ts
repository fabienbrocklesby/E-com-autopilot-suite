/**
 * Update sheet handler — stub for Phase 4.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep } from "../types.ts";

export const updateSheetHandler: StepHandler = {
  async execute(_step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    console.warn(`[playbook] update_sheet: not implemented yet (run ${ctx.run.id})`);
    return {
      decision: { action: "fail", error: "update_sheet step not implemented until Phase 4" },
    };
  },
};
