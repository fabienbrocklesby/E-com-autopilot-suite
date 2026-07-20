import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { appendMessageToWaitingRun, resolveInboundRunAction } from "./gmail.ts";

Deno.test("resolveInboundRunAction resumes a waiting_for_customer run", () => {
  assertEquals(resolveInboundRunAction("waiting_for_customer"), "resume");
});

Deno.test("resolveInboundRunAction attaches to a waiting_for_human run instead of cancelling it", () => {
  assertEquals(resolveInboundRunAction("waiting_for_human"), "attach_to_waiting_human");
});

Deno.test("resolveInboundRunAction requeues a waiting_to_send run instead of losing the delayed reply", () => {
  assertEquals(resolveInboundRunAction("waiting_to_send"), "requeue_send");
});

Deno.test("resolveInboundRunAction leaves a running run alone - the next advanceRun sees the message", () => {
  assertEquals(resolveInboundRunAction("running"), "store_only");
});

Deno.test("resolveInboundRunAction leaves a retrying run alone", () => {
  assertEquals(resolveInboundRunAction("retrying"), "store_only");
});

Deno.test("resolveInboundRunAction allows recategorisation when there is no active run", () => {
  assertEquals(resolveInboundRunAction(null), "none");
});

Deno.test("resolveInboundRunAction allows recategorisation for every terminal status", () => {
  assertEquals(resolveInboundRunAction("complete"), "none");
  assertEquals(resolveInboundRunAction("failed"), "none");
  assertEquals(resolveInboundRunAction("escalated"), "none");
  assertEquals(resolveInboundRunAction("cancelled"), "none");
});

Deno.test("appendMessageToWaitingRun creates the array on the first inbound message", () => {
  const result = appendMessageToWaitingRun({}, {
    message_id: 42,
    received_at: "2026-07-20T00:00:00.000Z",
  });
  assertEquals(result._messages_since_draft, [
    { message_id: 42, received_at: "2026-07-20T00:00:00.000Z" },
  ]);
});

Deno.test("appendMessageToWaitingRun appends without losing prior entries", () => {
  const existing = {
    _messages_since_draft: [{ message_id: 1, received_at: "2026-07-19T00:00:00.000Z" }],
  };
  const result = appendMessageToWaitingRun(existing, {
    message_id: 2,
    received_at: "2026-07-20T00:00:00.000Z",
  });
  assertEquals(result._messages_since_draft, [
    { message_id: 1, received_at: "2026-07-19T00:00:00.000Z" },
    { message_id: 2, received_at: "2026-07-20T00:00:00.000Z" },
  ]);
});
