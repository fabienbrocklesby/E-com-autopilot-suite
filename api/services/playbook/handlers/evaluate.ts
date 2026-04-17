/**
 * Evaluate handler - AI-driven three-way routing.
 *
 * Fast path: if all required vars are present (non-null, non-empty), advance
 * deterministically without any AI call. This avoids GPT-4o misinterpreting a
 * natural-language goal string and escalating runs that are actually fine.
 *
 * Slow path: one or more required vars are missing. Call AI with the FULL
 * context bag so it can judge whether the info is already present (just not
 * extracted) or truly absent, and whether the conversation is stuck.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep, EvaluateStep } from "../types.ts";
import { chatCompletion, getModel } from "../../ai.ts";

export const evaluateHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const evalStep = step as EvaluateStep;
    const requiredContext = evalStep.required_context ?? [];

    // ── Deterministic pre-check ─────────────────────────────────────────────
    // If every required variable has a non-null, non-empty value, skip the AI
    // call entirely. Zero tokens, zero risk of goal-string misinterpretation.
    const missing = requiredContext.filter((key) => {
      const val = ctx.variables[key];
      return val === null || val === undefined || val === "";
    });

    if (missing.length === 0) {
      console.log(
        `[playbook] evaluate: all required vars present (deterministic), advancing for run ${ctx.run.id}`,
      );
      return {
        decision: { action: "advance_to", stepId: evalStep.if_satisfied_goto },
        output: {
          action: "satisfied",
          reasoning: "All required variables present (deterministic check)",
          skipped_ai: true,
        },
      };
    }

    // ── AI path: something is missing ──────────────────────────────────────
    // Show the AI the FULL context bag so it can spot info that the extract
    // step may have missed (e.g. the customer quoted their order number in a
    // free-text reply that wasn't formally extracted).
    // No GOAL string - the AI's job is variable presence/validity, not intent.
    const recentMessages = ctx.messages.slice(-3);
    const recentMessagesText = recentMessages
      .map((m) => `${m.direction === "inbound" ? "CUSTOMER" : "US"}: ${m.body_plain.trim()}`)
      .join("\n\n");

    const model = await getModel(ctx.workspaceId);

    const systemPrompt = `You are checking whether a customer support workflow has everything it needs to proceed to the next step.

REQUIRED VARIABLES (all must be present and valid for the workflow to continue):
${requiredContext.map((key) => `- ${key}: ${ctx.variables[key] ?? "(MISSING)"}`).join("\n")}

FULL CONTEXT (everything we know so far):
${JSON.stringify(ctx.variables, null, 2)}

RECENT CONVERSATION (last 3 messages):
${recentMessagesText}

YOUR TASK:
Check each REQUIRED VARIABLE:
1. Is it present (not null, not empty string, not undefined)?
2. Does its value look real and usable (not "idk", not gibberish, not a placeholder)?

If ALL required variables are present and valid:
  Return {"action": "satisfied", "reasoning": "..."}

If any required variable is MISSING (null or empty):
  Return {"action": "missing", "missing_vars": ["var1", ...], "reasoning": "..."}

If a required variable EXISTS but its value looks wrong, fake, or the conversation has gone off the rails:
  Return {"action": "escalate", "reason": "..."}

Output JSON only. No markdown, no explanation outside the JSON.`;

    const response = await chatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Evaluate." },
      ],
      model,
      { type: "json_object" },
    );

    const aiCalls = [{ model, prompt: systemPrompt, response, tokens: undefined }];

    let parsed: {
      action?: string;
      reasoning?: string;
      reason?: string;
      missing_vars?: string[];
    };
    try {
      parsed = JSON.parse(response);
    } catch {
      // Unparseable AI response - default to missing so the run asks the customer
      // rather than escalating or advancing with unknown state.
      console.warn(
        `[playbook] evaluate: AI response parse failed, defaulting to missing for run ${ctx.run.id}`,
      );
      return {
        decision: { action: "advance_to", stepId: evalStep.if_missing_goto },
        output: { action: "missing", reasoning: "AI parse failed, defaulted to missing" },
        aiCalls,
      };
    }

    if (parsed.action === "satisfied") {
      // AI confirmed all required variables are effectively present (possibly
      // found in free-text conversation even though the formal extract missed them).
      console.log(`[playbook] evaluate: AI confirmed satisfied for run ${ctx.run.id}`);
      return {
        decision: { action: "advance_to", stepId: evalStep.if_satisfied_goto },
        output: { action: "satisfied", reasoning: parsed.reasoning },
        aiCalls,
      };
    }

    if (parsed.action === "escalate") {
      console.log(
        `[playbook] evaluate: AI escalated - ${parsed.reason} for run ${ctx.run.id}`,
      );
      return {
        decision: { action: "advance_to", stepId: evalStep.if_escalate_goto },
        output: { action: "escalated", reason: parsed.reason },
        aiCalls,
      };
    }

    // Default (missing or unrecognised action) → route to ask_customer fallback
    console.log(
      `[playbook] evaluate: missing required vars for run ${ctx.run.id}: ${missing.join(", ")}`,
    );
    return {
      decision: { action: "advance_to", stepId: evalStep.if_missing_goto },
      output: { action: "missing", reasoning: parsed.reasoning, missing },
      aiCalls,
    };
  },
};
