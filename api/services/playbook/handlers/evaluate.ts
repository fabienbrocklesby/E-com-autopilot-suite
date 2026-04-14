/**
 * Evaluate handler — AI-driven three-way routing.
 * Deterministic when vars are clearly present/absent; calls AI for judgment calls.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep, EvaluateStep } from "../types.ts";
import { chatCompletion, getModel } from "../../ai.ts";
import { queryOne } from "../../../db/client.ts";

export const evaluateHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const evalStep = step as EvaluateStep;
    const required = evalStep.required_context ?? [];

    // Load category voice for the AI prompt
    const category = ctx.playbook.category_id
      ? await queryOne<{ writing_style: string | null }>(
          "SELECT writing_style FROM categories WHERE id = $1",
          [ctx.playbook.category_id],
        )
      : null;

    const recentMessages = ctx.messages.slice(-5);
    const transcript = recentMessages
      .map((m) => `${m.direction === "inbound" ? "CUSTOMER" : "US"}: ${m.body_plain.trim()}`)
      .join("\n\n");

    const have: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const v of required) {
      if (ctx.variables[v] != null) {
        have[v] = ctx.variables[v];
      } else {
        missing.push(v);
      }
    }

    const model = await getModel(ctx.workspaceId);

    // PATH A: all required vars are present — ask AI to confirm it's actually sufficient
    if (missing.length === 0) {
      const systemPrompt = `You are evaluating whether we have everything needed to proceed with a customer support task.

GOAL: ${evalStep.goal}

CONTEXT WE HAVE:
${JSON.stringify(have, null, 2)}

RECENT CONVERSATION:
${transcript}

Is everything in order to proceed, or is something wrong?

Return one of:
- {"action": "satisfied", "reasoning": "..."} if all info is correct and meaningful
- {"action": "escalate", "reason": "..."} if something looks wrong (e.g. a value is clearly invalid, nonsensical, or the conversation is problematic)

Output JSON only.`;

      const response = await chatCompletion(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Evaluate." },
        ],
        model,
        { type: "json_object" },
      );

      const aiCalls = [{ model, prompt: systemPrompt, response, tokens: undefined }];

      let parsed: { action?: string; reasoning?: string; reason?: string };
      try {
        parsed = JSON.parse(response);
      } catch {
        // If AI fails to parse, default to satisfied
        console.warn(`[playbook] evaluate: AI response parse failed, defaulting to satisfied for run ${ctx.run.id}`);
        return {
          decision: { action: "advance_to", stepId: evalStep.if_satisfied_goto },
          output: { action: "satisfied", reasoning: "AI parse failed, defaulted to satisfied" },
          aiCalls,
        };
      }

      if (parsed.action === "escalate") {
        console.log(`[playbook] evaluate: AI escalated — ${parsed.reason} for run ${ctx.run.id}`);
        return {
          decision: { action: "advance_to", stepId: evalStep.if_escalate_goto },
          output: { action: "escalated", reason: parsed.reason },
          aiCalls,
        };
      }

      console.log(`[playbook] evaluate: satisfied for run ${ctx.run.id}`);
      return {
        decision: { action: "advance_to", stepId: evalStep.if_satisfied_goto },
        output: { action: "satisfied", reasoning: parsed.reasoning },
        aiCalls,
      };
    }

    // PATH B: required vars are missing — ask AI whether the customer already gave us the info
    const fullContext = { ...ctx.variables };
    const systemPrompt = `You are deciding how to proceed with a customer support task when some information is missing.

GOAL: ${evalStep.goal}

WHAT WE HAVE:
${JSON.stringify(have, null, 2)}

WHAT WE STILL NEED:
${missing.join(", ")}

RECENT CONVERSATION:
${transcript}

Return one of:
- {"action": "missing", "reasoning": "..."} if the customer hasn't given us what we need yet
- {"action": "actually_have_it", "extracted": {"var1": "value", ...}, "reasoning": "..."} if the customer gave us the info in a different form we can extract
- {"action": "escalate", "reason": "..."} if the conversation is stuck or something is seriously wrong

Output JSON only.`;

    const response = await chatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Evaluate." },
      ],
      model,
      { type: "json_object" },
    );

    const aiCalls = [{ model, prompt: systemPrompt, response, tokens: undefined }];

    let parsed: { action?: string; extracted?: Record<string, unknown>; reasoning?: string; reason?: string };
    try {
      parsed = JSON.parse(response);
    } catch {
      console.warn(`[playbook] evaluate: AI response parse failed, routing to missing for run ${ctx.run.id}`);
      return {
        decision: { action: "advance_to", stepId: evalStep.if_missing_goto },
        output: { action: "missing", reasoning: "AI parse failed, defaulted to missing" },
        aiCalls,
      };
    }

    if (parsed.action === "actually_have_it") {
      console.log(`[playbook] evaluate: AI extracted missing vars for run ${ctx.run.id}`);
      return {
        decision: { action: "advance_to", stepId: evalStep.if_satisfied_goto },
        contextUpdates: parsed.extracted ?? {},
        output: { action: "actually_have_it", reasoning: parsed.reasoning, extracted: parsed.extracted },
        aiCalls,
      };
    }

    if (parsed.action === "escalate") {
      console.log(`[playbook] evaluate: AI escalated — ${parsed.reason} for run ${ctx.run.id}`);
      return {
        decision: { action: "advance_to", stepId: evalStep.if_escalate_goto },
        output: { action: "escalated", reason: parsed.reason },
        aiCalls,
      };
    }

    console.log(`[playbook] evaluate: missing required vars for run ${ctx.run.id}: ${missing.join(", ")}`);
    return {
      decision: { action: "advance_to", stepId: evalStep.if_missing_goto },
      output: { action: "missing", reasoning: parsed.reasoning, missing },
      aiCalls,
    };
  },
};
