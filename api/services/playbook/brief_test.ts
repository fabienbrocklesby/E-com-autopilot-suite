import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { shouldRegenerateSummary } from "./brief.ts";
import type { ThreadBrief } from "./brief.ts";
import type { Message } from "../../types/index.ts";

function makeMessages(count: number, latestReceivedAt: Date): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    thread_id: 1,
    gmail_message_id: `gmail-${i + 1}`,
    from_address: "customer@example.com",
    body_plain: `message ${i + 1}`,
    body_html: "",
    received_at: i === count - 1
      ? latestReceivedAt
      : new Date(latestReceivedAt.getTime() - (count - i) * 60_000),
    direction: "inbound" as const,
    message_id_header: null,
  }));
}

const emptyBrief: ThreadBrief = { summary: null, facts: {}, updated_at: null };

Deno.test("shouldRegenerateSummary is false for threads at or under 8 messages, regardless of brief state", () => {
  const messages = makeMessages(8, new Date("2026-07-20T12:00:00Z"));
  assertEquals(shouldRegenerateSummary(messages, emptyBrief), false);
});

Deno.test("shouldRegenerateSummary is true for a long thread with no existing summary", () => {
  const messages = makeMessages(9, new Date("2026-07-20T12:00:00Z"));
  assertEquals(shouldRegenerateSummary(messages, emptyBrief), true);
});

Deno.test("shouldRegenerateSummary is true when the brief predates the latest message", () => {
  const messages = makeMessages(12, new Date("2026-07-20T12:00:00Z"));
  const staleBrief: ThreadBrief = {
    summary: "Old summary",
    facts: {},
    updated_at: "2026-07-20T11:00:00Z",
  };
  assertEquals(shouldRegenerateSummary(messages, staleBrief), true);
});

Deno.test("shouldRegenerateSummary is false when the brief is newer than the latest message", () => {
  const messages = makeMessages(12, new Date("2026-07-20T12:00:00Z"));
  const freshBrief: ThreadBrief = {
    summary: "Fresh summary",
    facts: {},
    updated_at: "2026-07-20T12:30:00Z",
  };
  assertEquals(shouldRegenerateSummary(messages, freshBrief), false);
});
