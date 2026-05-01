import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { TriageStep } from "../types.ts";
import { resolveTriageDecision } from "./triage.ts";

const shopifyTriageStep: TriageStep = {
  id: "triage_1",
  type: "triage",
  goal: "Decide whether this Shopify email needs a response.",
  routes: [
    {
      label: "no_action",
      description: "Informational Shopify notification with no requested task.",
      goto: "complete_1",
    },
    {
      label: "needs_response",
      description: "Customer question or action request.",
      goto: "send_1",
    },
  ],
  fallback_goto: "send_1",
  confidence_threshold: 0.7,
};

Deno.test("resolveTriageDecision routes high-confidence no-action notifications to complete", () => {
  const decision = resolveTriageDecision(shopifyTriageStep, {
    route: "no_action",
    confidence: 0.92,
    reasoning: "This is a Shopify new order notification with no request.",
  });

  assertEquals(decision.stepId, "complete_1");
  assertEquals(decision.route, "no_action");
  assertEquals(decision.usedFallback, false);
});

Deno.test("resolveTriageDecision falls back for low-confidence no-action classifications", () => {
  const decision = resolveTriageDecision(shopifyTriageStep, {
    route: "no_action",
    confidence: 0.61,
    reasoning: "Might be informational.",
  });

  assertEquals(decision.stepId, "send_1");
  assertEquals(decision.route, "no_action");
  assertEquals(decision.usedFallback, true);
  assertEquals(decision.fallbackReason, "low_confidence");
});

Deno.test("resolveTriageDecision falls back for invalid AI route labels", () => {
  const decision = resolveTriageDecision(shopifyTriageStep, {
    route: "maybe",
    confidence: 0.99,
    reasoning: "Invalid label.",
  });

  assertEquals(decision.stepId, "send_1");
  assertEquals(decision.route, "maybe");
  assertEquals(decision.usedFallback, true);
  assertEquals(decision.fallbackReason, "invalid_route");
});
