import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveSimulatedFollowUp } from "./dry-run.ts";
import type { AskCustomerStep } from "./types.ts";

const askStep: AskCustomerStep = {
  id: "ask_1",
  type: "ask_customer",
  on_reply_goto: "send_1",
};

Deno.test("resolveSimulatedFollowUp is a no-op when no follow-up message is provided", () => {
  const result = resolveSimulatedFollowUp(askStep, "Hi, where is my order?", undefined, false);
  assertEquals(result.consumed, false);
});

Deno.test("resolveSimulatedFollowUp is a no-op once already consumed", () => {
  const result = resolveSimulatedFollowUp(askStep, "Hi, where is my order?", "It's order #123", true);
  assertEquals(result.consumed, false);
});

Deno.test("resolveSimulatedFollowUp injects the reply and resumes at on_reply_goto", () => {
  const result = resolveSimulatedFollowUp(askStep, "Hi, where is my order?", "It's order #123", false);
  assertEquals(result.consumed, true);
  if (result.consumed) {
    assertEquals(result.nextStepId, "send_1");
    assertEquals(
      result.nextEmailContent,
      "Hi, where is my order?\n\n---\n\n[Simulated customer reply]\nIt's order #123",
    );
  }
});
