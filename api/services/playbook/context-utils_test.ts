import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatBriefBlock, formatCappedTranscript, isPresent } from "./context-utils.ts";
import type { Message } from "../../types/index.ts";
import type { ThreadBrief } from "./brief.ts";

function makeMessage(id: number): Message {
  return {
    id,
    thread_id: 1,
    gmail_message_id: `gmail-${id}`,
    from_address: "customer@example.com",
    body_plain: `message ${id}`,
    body_html: "",
    received_at: new Date(2026, 0, 1, 0, 0, id),
    direction: "inbound",
    message_id_header: null,
  };
}

Deno.test("isPresent treats null and undefined as absent", () => {
  assertEquals(isPresent(null), false);
  assertEquals(isPresent(undefined), false);
});

Deno.test("isPresent treats empty and whitespace-only strings as absent - the ask_customer behaviour change", () => {
  // ask_customer previously used `== null`, which treated "" as present and
  // would skip asking the customer for a var that was extracted as an empty
  // string. isPresent closes that gap: "" now counts as missing.
  assertEquals(isPresent(""), false);
  assertEquals(isPresent("   "), false);
});

Deno.test("isPresent treats 0 and false as present", () => {
  assertEquals(isPresent(0), true);
  assertEquals(isPresent(false), true);
});

Deno.test("isPresent treats non-empty strings and objects as present", () => {
  assertEquals(isPresent("12345"), true);
  assertEquals(isPresent({ a: 1 }), true);
});

Deno.test("formatCappedTranscript returns the full transcript at or under 30 messages", () => {
  const messages = Array.from({ length: 30 }, (_, i) => makeMessage(i + 1));
  const result = formatCappedTranscript(messages, "irrelevant summary");

  assertStringIncludes(result, "message 1");
  assertStringIncludes(result, "message 30");
  assertEquals(result.includes("EARLIER CONVERSATION"), false);
});

Deno.test("formatCappedTranscript caps long threads to a summary block plus the last 10 messages", () => {
  const messages = Array.from({ length: 45 }, (_, i) => makeMessage(i + 1));
  const result = formatCappedTranscript(
    messages,
    "Customer is waiting on a refund for order 4521.",
  );

  assertStringIncludes(
    result,
    "EARLIER CONVERSATION (summary): Customer is waiting on a refund for order 4521.",
  );
  assertStringIncludes(result, "message 36");
  assertStringIncludes(result, "message 45");
  assertEquals(result.includes("message 35"), false);
});

Deno.test("formatCappedTranscript notes truncation when no summary is available for a long thread", () => {
  const messages = Array.from({ length: 31 }, (_, i) => makeMessage(i + 1));
  const result = formatCappedTranscript(messages, null);

  assertStringIncludes(
    result,
    "EARLIER CONVERSATION (summary): (21 earlier messages not shown; no summary available yet)",
  );
});

Deno.test("formatBriefBlock returns an empty string when the brief has no facts and no summary", () => {
  const brief: ThreadBrief = { summary: null, facts: {}, updated_at: null };
  assertEquals(formatBriefBlock(brief), "");
});

Deno.test("formatBriefBlock renders a facts key/value list when facts are present", () => {
  const brief: ThreadBrief = {
    summary: null,
    facts: { order_number: "4521", refund_offered: "20" },
    updated_at: null,
  };
  const result = formatBriefBlock(brief);
  assertStringIncludes(result, "THREAD BRIEF");
  assertStringIncludes(result, "order_number");
  assertStringIncludes(result, "4521");
  assertStringIncludes(result, "refund_offered");
});

Deno.test("formatBriefBlock appends a Summary line when a summary is present", () => {
  const brief: ThreadBrief = {
    summary: "Customer is chasing a delayed order.",
    facts: {},
    updated_at: "2026-07-19T00:00:00.000Z",
  };
  assertStringIncludes(formatBriefBlock(brief), "Summary: Customer is chasing a delayed order.");
});

Deno.test("formatBriefBlock renders facts and summary together", () => {
  const brief: ThreadBrief = {
    summary: "Customer wants a refund.",
    facts: { order_number: "4521" },
    updated_at: "2026-07-19T00:00:00.000Z",
  };
  const result = formatBriefBlock(brief);
  assertStringIncludes(result, "order_number");
  assertStringIncludes(result, "Summary: Customer wants a refund.");
});
