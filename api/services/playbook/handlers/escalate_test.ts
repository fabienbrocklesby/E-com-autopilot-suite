import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { EscalateStep, RunContext } from "../types.ts";
import { escalateHandler } from "./escalate.ts";

const escalateStep: EscalateStep = {
  id: "escalate_1",
  type: "escalate",
  reason: "Could not find order in sheet",
};

function buildCtx(variables: Record<string, unknown>): RunContext {
  return {
    run: {
      id: 1,
      workspace_id: 1,
      thread_id: 1,
      playbook_id: 1,
      playbook_version: 1,
      current_step_id: "escalate_1",
      status: "running",
      context: variables,
      retry_count: 0,
      next_retry_at: null,
      send_after: null,
      created_at: new Date(),
      updated_at: new Date(),
    },
    playbook: {
      id: 1,
      workspace_id: 1,
      category_id: 1,
      name: "Test playbook",
      plain_language_description: null,
      steps: [escalateStep],
      version: 1,
      is_active: true,
      customer_silence_hours: 168,
      writing_style: "",
      reply_mode: "draft_only",
      confidence_threshold: 0.8,
      approval_streak: 0,
      auto_send_streak_target: 10,
      created_at: new Date(),
      updated_at: new Date(),
    },
    threadId: 1,
    workspaceId: 1,
    variables,
    messages: [],
    email: "store@example.com",
    gmailThreadId: "gmail-thread-1",
    subject: "Test",
    senderName: null,
    storeProfile: null,
  };
}

Deno.test("escalateHandler uses _rejection_source over everything else when set", async () => {
  const ctx = buildCtx({ _rejection_source: "approval_1 (Process refund in Stripe)" });
  const result = await escalateHandler.execute(escalateStep, ctx);
  assertEquals(result.decision, {
    action: "escalate",
    reason: "Rejected by human: approval_1 (Process refund in Stripe)",
  });
});

Deno.test("escalateHandler uses a dynamic context reason when _rejection_source is absent", async () => {
  const ctx = buildCtx({ _escalation_reason: "find_sheet_row could not match order 1234" });
  const result = await escalateHandler.execute(escalateStep, ctx);
  assertEquals(result.decision, {
    action: "escalate",
    reason: "find_sheet_row could not match order 1234",
  });
});

Deno.test("escalateHandler falls back to the step's static config reason when context has neither", async () => {
  const ctx = buildCtx({});
  const result = await escalateHandler.execute(escalateStep, ctx);
  assertEquals(result.decision, {
    action: "escalate",
    reason: "Could not find order in sheet",
  });
});
