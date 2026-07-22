import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assembleComposerContext,
  buildAskSystemPrompt,
  buildReplySystemPrompt,
  IDENTITY_AND_HONESTY_RULES,
} from "./composer.ts";
import type { ComposerInputs } from "./composer.ts";
import type { ThreadBrief } from "./brief.ts";
import type { Playbook, PlaybookRun, RunContext } from "./types.ts";
import type { Message } from "../../types/index.ts";

function makeMessage(id: number, direction: "inbound" | "outbound" = "inbound"): Message {
  return {
    id,
    thread_id: 1,
    gmail_message_id: `gmail-${id}`,
    from_address: direction === "inbound" ? "customer@example.com" : "support@store.com",
    body_plain: `message body ${id}`,
    body_html: "",
    received_at: new Date(2026, 0, 1, 0, 0, id),
    direction,
    message_id_header: null,
  };
}

function makePlaybook(): Playbook {
  return {
    id: 1,
    workspace_id: 1,
    category_id: 1,
    name: "Test playbook",
    plain_language_description: null,
    steps: [],
    version: 1,
    is_active: true,
    customer_silence_hours: 168,
    writing_style: "friendly and professional",
    reply_mode: "draft_only",
    confidence_threshold: 0.8,
    approval_streak: 0,
    auto_send_streak_target: 10,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function makeRun(): PlaybookRun {
  return {
    id: 1,
    workspace_id: 1,
    thread_id: 1,
    playbook_id: 1,
    playbook_version: 1,
    steps_snapshot: [],
    current_step_id: "ask_1",
    status: "running",
    context: {},
    retry_count: 0,
    next_retry_at: null,
    send_after: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function makeCtx(messages: Message[], variables: Record<string, unknown> = {}): RunContext {
  return {
    run: makeRun(),
    playbook: makePlaybook(),
    threadId: 1,
    workspaceId: 1,
    variables,
    messages,
    email: "store@example.com",
    gmailThreadId: "gmail-thread-1",
    subject: "Where is my order?",
    senderName: "Kieran",
    storeProfile: "STORE: Exclusive Motors",
  };
}

const emptyBrief: ThreadBrief = { summary: null, facts: {}, updated_at: null };

Deno.test("assembleComposerContext includes the full transcript and sign-off for a short thread", () => {
  const messages = Array.from({ length: 5 }, (_, i) => makeMessage(i + 1));
  const inputs: ComposerInputs = {
    ctx: makeCtx(messages, { order_number: "4521" }),
    goal: "Confirm the order number",
    voice: undefined,
    requiredContext: ["order_number"],
    priorSent: [],
  };

  const result = assembleComposerContext(inputs, emptyBrief, null);

  assertStringIncludes(result, "message body 1");
  assertStringIncludes(result, "message body 5");
  assertStringIncludes(result, "SIGN OFF AS: Kieran");
  assertStringIncludes(result, "STORE CONTEXT");
  // Empty brief (no facts, no summary yet) - formatBriefBlock omits the
  // section entirely, matching evaluate.ts/triage.ts's own THREAD BRIEF
  // behaviour instead of a hand-rolled "(none yet)" placeholder.
  assertEquals(result.includes("THREAD BRIEF"), false);
});

Deno.test("assembleComposerContext caps a long thread's transcript and surfaces the brief summary and facts", () => {
  const messages = Array.from({ length: 40 }, (_, i) => makeMessage(i + 1));
  const brief: ThreadBrief = {
    summary: "Customer is chasing a delayed order and has been offered a partial refund.",
    facts: { order_number: "4521", refund_offered: "20" },
    updated_at: "2026-07-19T00:00:00.000Z",
  };
  const inputs: ComposerInputs = {
    ctx: makeCtx(messages, { order_number: "4521" }),
    goal: "Close out the refund conversation",
    voice: "warm and direct",
    requiredContext: ["order_number", "tracking_number"],
    priorSent: ["Can you confirm your order number?"],
  };

  const result = assembleComposerContext(inputs, brief, brief.summary);

  assertStringIncludes(result, "THREAD BRIEF");
  assertStringIncludes(result, "Customer is chasing a delayed order");
  assertStringIncludes(result, "refund_offered");
  assertStringIncludes(result, "WHAT WE STILL NEED");
  assertStringIncludes(result, "tracking_number");
  assertStringIncludes(result, "message body 31");
  assertStringIncludes(result, "message body 40");
  assertEquals(result.includes("message body 20"), false);
  assertStringIncludes(result, "Can you confirm your order number?");
});

Deno.test("assembleComposerContext filters ctx.variables through isPresent for WHAT WE KNOW", () => {
  const messages = [makeMessage(1)];
  const inputs: ComposerInputs = {
    ctx: makeCtx(messages, { order_number: "4521", customer_name: "", quantity: 0 }),
    goal: "Test presence filtering",
    voice: undefined,
    requiredContext: [],
    priorSent: [],
  };

  const result = assembleComposerContext(inputs, emptyBrief, null);
  const knowSection = result.split("WHAT WE KNOW:")[1].split("WHAT WE STILL NEED:")[0];

  assertStringIncludes(knowSection, "order_number");
  assertStringIncludes(knowSection, "quantity");
  assertEquals(knowSection.includes("customer_name"), false);
});

Deno.test("IDENTITY_AND_HONESTY_RULES anchors identity as the seller and forbids fabrication", () => {
  // The store IS the seller: replies must never send the customer elsewhere.
  assertStringIncludes(IDENTITY_AND_HONESTY_RULES, "you ARE the seller");
  // Hard anti-fabrication rule covering the exact values GPT-4o was inventing
  // (a made-up seller email, tracking numbers, delivery dates).
  assertStringIncludes(IDENTITY_AND_HONESTY_RULES, "Never invent or guess");
  assertStringIncludes(IDENTITY_AND_HONESTY_RULES, "tracking number");
  assertStringIncludes(IDENTITY_AND_HONESTY_RULES, "email address");
});

Deno.test("buildReplySystemPrompt carries the shared guard and preserves existing reply rules", () => {
  const prompt = buildReplySystemPrompt({
    goal: "Reply about their order",
    voice: "friendly NZ",
    referenceContext: { order_number: "4521" },
    composerContext: "STORE CONTEXT:\nSTORE: Exclusive Motors",
    senderName: "Kieran",
  });

  // New guard is present verbatim (same source as the ask path - no drift).
  assertStringIncludes(prompt, IDENTITY_AND_HONESTY_RULES);
  // Existing behaviour still intact.
  assertStringIncludes(prompt, "Reply about their order");
  assertStringIncludes(prompt, "friendly NZ");
  assertStringIncludes(prompt, "Sign off using the exact name: Kieran");
  assertStringIncludes(prompt, "STORE: Exclusive Motors");
  assertStringIncludes(prompt, "Return ONLY the message body");
});

Deno.test("buildAskSystemPrompt carries the shared guard and preserves existing ask rules", () => {
  const prompt = buildAskSystemPrompt({
    goal: "Ask for the order number",
    voice: "friendly NZ",
    composerContext: "STORE CONTEXT:\nSTORE: Exclusive Motors",
    senderName: null,
  });

  // Same guard string as the reply path.
  assertStringIncludes(prompt, IDENTITY_AND_HONESTY_RULES);
  // Existing behaviour still intact.
  assertStringIncludes(prompt, "Ask for the order number");
  assertStringIncludes(prompt, "Output JSON only");
  // senderName null keeps the no-name-placeholder rule.
  assertStringIncludes(prompt, "Do not include a name placeholder");
});
