/**
 * Escalate handler - terminates the run in status 'escalated' with the real
 * cause recorded. Reason precedence: an explicit human rejection always wins
 * (_rejection_source, set by the reject route), then a dynamic reason some
 * upstream step already computed and stashed in context (_escalation_reason),
 * then the step's own static config reason as the last resort. This is what
 * stops "Could not find order in sheet" showing up when the real cause was
 * something else entirely - the step's static string is now the fallback,
 * not the only option.
 */
import type { EscalateStep, PlaybookStep, RunContext, StepHandler, StepResult } from "../types.ts";

export const escalateHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const escalateStep = step as EscalateStep;

    const rejectionSource = ctx.variables._rejection_source as string | undefined;
    const dynamicReason = ctx.variables._escalation_reason as string | undefined;
    const reason = rejectionSource
      ? `Rejected by human: ${rejectionSource}`
      : dynamicReason ?? escalateStep.reason;

    console.log(`[playbook] escalate: run ${ctx.run.id} - ${reason}`);
    return {
      decision: { action: "escalate", reason },
      output: { reason },
    };
  },
};
