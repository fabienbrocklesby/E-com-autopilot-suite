/**
 * Branch handler — evaluates a condition against the context bag and routes
 * to if_true or if_false step.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep, BranchStep } from "../types.ts";

export const branchHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const branchStep = step as BranchStep;

    // Evaluate the condition against the context variables.
    // Supports simple expressions like "context.order_number != null"
    const result = evaluateCondition(branchStep.condition, ctx.variables);

    const targetStepId = result ? branchStep.if_true : branchStep.if_false;

    return {
      decision: { action: "advance_to", stepId: targetStepId },
      output: { condition: branchStep.condition, result, target: targetStepId },
    };
  },
};

/**
 * Evaluate a simple condition string against variables.
 * Supports patterns like:
 *   - "context.var_name != null"
 *   - "context.var_name == null"
 *   - "context.var_name"  (truthy check)
 */
function evaluateCondition(condition: string, variables: Record<string, unknown>): boolean {
  // Strip "context." prefix for variable references
  const normalized = condition.trim();

  // Pattern: context.X != null
  const neqNull = normalized.match(/^context\.(\w+)\s*!=\s*null$/);
  if (neqNull) {
    const val = variables[neqNull[1]];
    return val !== null && val !== undefined;
  }

  // Pattern: context.X == null
  const eqNull = normalized.match(/^context\.(\w+)\s*==\s*null$/);
  if (eqNull) {
    const val = variables[eqNull[1]];
    return val === null || val === undefined;
  }

  // Pattern: context.X (truthy)
  const truthyMatch = normalized.match(/^context\.(\w+)$/);
  if (truthyMatch) {
    return !!variables[truthyMatch[1]];
  }

  console.warn(`[branch] Unrecognized condition format: "${condition}", defaulting to false`);
  return false;
}
