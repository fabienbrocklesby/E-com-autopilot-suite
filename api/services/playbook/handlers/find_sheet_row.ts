/**
 * Find sheet row handler — stub for Phase 4.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep } from "../types.ts";

export const findSheetRowHandler: StepHandler = {
  async execute(_step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    console.warn(`[playbook] find_sheet_row: not implemented yet (run ${ctx.run.id})`);
    return {
      decision: { action: "fail", error: "find_sheet_row step not implemented until Phase 4" },
    };
  },
};
