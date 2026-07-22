import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  appendAttachmentMarkers,
  appendMessageToWaitingRun,
  appendSignature,
  formatFromHeader,
  resolveInboundRunAction,
} from "./gmail.ts";

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

Deno.test("formatFromHeader returns a quoted display name with the store name", () => {
  const result = formatFromHeader("Exclusive Motors", "store@example.com");
  assertEquals(result, '"Exclusive Motors" <store@example.com>');
});

Deno.test("formatFromHeader falls back to the bare address when store name is unset", () => {
  assertEquals(formatFromHeader(null, "store@example.com"), "store@example.com");
  assertEquals(formatFromHeader("   ", "store@example.com"), "store@example.com");
});

Deno.test("formatFromHeader escapes embedded quotes in the display name", () => {
  const result = formatFromHeader('The "Best" Store', "store@example.com");
  assertEquals(result, '"The \\"Best\\" Store" <store@example.com>');
});

Deno.test("appendSignature appends the configured signature when absent", () => {
  const result = appendSignature("Thanks for reaching out.", "Sarah from Support");
  assertEquals(result, "Thanks for reaching out.\n\nBest regards,\nSarah from Support");
});

Deno.test("appendSignature does not duplicate a signature already present", () => {
  const body = "Thanks for reaching out.\n\nBest regards,\nSarah from Support";
  assertEquals(appendSignature(body, "Sarah from Support"), body);
});

Deno.test("appendSignature does not double up when the AI already signed off with a different closing phrase", () => {
  // composer.ts's prompt tells the AI to close with the exact sender name, but
  // not in this literal "Best regards," phrasing - this is the real-world case
  // an exact-block idempotency check would miss.
  const body = "Thanks for reaching out.\n\nThanks,\nSarah from Support";
  assertEquals(appendSignature(body, "Sarah from Support"), body);
});

Deno.test("appendSignature returns the body unchanged when no signature is configured", () => {
  assertEquals(appendSignature("Thanks for reaching out.", null), "Thanks for reaching out.");
  assertEquals(appendSignature("Thanks for reaching out.", "  "), "Thanks for reaching out.");
});

Deno.test("appendAttachmentMarkers appends one marker per filename", () => {
  const result = appendAttachmentMarkers("Here is my order.", ["receipt.pdf", "photo.jpg"]);
  assertEquals(result, "Here is my order.\n\n[attachment: receipt.pdf]\n[attachment: photo.jpg]");
});

Deno.test("appendAttachmentMarkers returns the text unchanged when there are no attachments", () => {
  assertEquals(appendAttachmentMarkers("Here is my order.", []), "Here is my order.");
});

Deno.test("appendAttachmentMarkers works against an empty body", () => {
  assertEquals(appendAttachmentMarkers("", ["photo.jpg"]), "[attachment: photo.jpg]");
});
