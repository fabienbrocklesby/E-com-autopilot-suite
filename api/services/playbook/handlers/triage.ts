/**
 * Triage handler - AI-driven route selection for intent/actionability decisions.
 *
 * Use this for "should this thread be actioned?" style decisions. Keep
 * evaluate for variable-presence gates like "do we have order_number?"
 */
import type { PlaybookStep, RunContext, StepHandler, StepResult, TriageStep } from "../types.ts";
import { chatCompletion, getModel } from "../../ai.ts";
import { formatTranscript } from "../../email-text.ts";

interface ParsedTriageResponse {
  route?: string;
  confidence?: number;
  reasoning?: string;
}

interface ResolvedTriageDecision {
  stepId: string;
  route: string;
  confidence: number;
  reasoning: string;
  usedFallback: boolean;
  fallbackReason?: string;
}

function clampConfidence(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

export function resolveTriageDecision(
  step: TriageStep,
  parsed: ParsedTriageResponse,
): ResolvedTriageDecision {
  const threshold = typeof step.confidence_threshold === "number"
    ? step.confidence_threshold
    : 0.65;
  const confidence = clampConfidence(parsed.confidence);
  const route = typeof parsed.route === "string" ? parsed.route : "";
  const routeConfig = step.routes.find((candidate) => candidate.label === route);

  if (!routeConfig) {
    return {
      stepId: step.fallback_goto,
      route: route || "unknown",
      confidence,
      reasoning: parsed.reasoning ?? "AI returned no valid triage route.",
      usedFallback: true,
      fallbackReason: "invalid_route",
    };
  }

  if (confidence < threshold) {
    return {
      stepId: step.fallback_goto,
      route,
      confidence,
      reasoning: parsed.reasoning ?? "AI confidence was below the triage threshold.",
      usedFallback: true,
      fallbackReason: "low_confidence",
    };
  }

  return {
    stepId: routeConfig.goto,
    route,
    confidence,
    reasoning: parsed.reasoning ?? "",
    usedFallback: false,
  };
}

export const triageHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const triageStep = step as TriageStep;

    if (!Array.isArray(triageStep.routes) || triageStep.routes.length === 0) {
      return {
        decision: { action: "fail", error: "triage: no routes configured" },
      };
    }

    const routeLines = triageStep.routes
      .map((route) => `- ${route.label}: ${route.description}`)
      .join("\n");
    const transcript = formatTranscript(ctx.messages);
    const model = await getModel(ctx.workspaceId);

    const systemPrompt =
      `You are triaging an e-commerce support email thread and choosing the next workflow route.
${ctx.storeProfile ? `\nStore context:\n${ctx.storeProfile}\n` : ""}
GOAL:
${triageStep.goal}

THREAD SUBJECT:
${ctx.subject}

ROUTES:
${routeLines}

FULL WORKFLOW CONTEXT:
${JSON.stringify(ctx.variables, null, 2)}

THREAD TRANSCRIPT:
${transcript}

RULES:
- Choose exactly one route label from ROUTES.
- Treat automated platform notifications, receipts, order confirmations, payment notices, invoices, fulfilment notices, marketplace notices, and no-reply updates as no-action unless the message includes an actual question, requested task, supplier issue, complaint, or exception that needs a human/operator response.
- A normal Shopify order notification that only says someone placed an order is informational. It should not receive a reply.
- If the thread contains both an automated notification and a customer/supplier question, route based on the real question or requested action.
- If you are unsure, choose the route that gets human review instead of silently closing.

Return JSON only with:
{
  "route": "one route label",
  "confidence": 0.0 to 1.0,
  "reasoning": "one sentence"
}`;

    const response = await chatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Choose the route." },
      ],
      model,
      { type: "json_object" },
    );

    const aiCalls = [{ model, prompt: systemPrompt, response, tokens: undefined }];

    let parsed: ParsedTriageResponse;
    try {
      parsed = JSON.parse(response);
    } catch {
      const fallback = {
        stepId: triageStep.fallback_goto,
        route: "unknown",
        confidence: 0,
        reasoning: "AI response could not be parsed.",
        usedFallback: true,
        fallbackReason: "parse_failed",
      };

      return {
        decision: { action: "advance_to", stepId: triageStep.fallback_goto },
        output: fallback,
        aiCalls,
      };
    }

    const resolved = resolveTriageDecision(triageStep, parsed);
    console.log(
      `[playbook] triage: route=${resolved.route} confidence=${resolved.confidence} fallback=${resolved.usedFallback} run ${ctx.run.id}`,
    );

    return {
      decision: { action: "advance_to", stepId: resolved.stepId },
      output: { ...resolved },
      aiCalls,
    };
  },
};
