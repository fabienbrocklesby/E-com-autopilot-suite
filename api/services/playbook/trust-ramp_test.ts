import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeStreakTransition } from "./trust-ramp.ts";

const baseState = { approvalStreak: 0, autoSendStreakTarget: 10, replyMode: "draft_only" as const };

Deno.test("computeStreakTransition increments the streak on a clean approval", () => {
  const result = computeStreakTransition({ ...baseState, approvalStreak: 4 }, "approved_clean");
  assertEquals(result.nextApprovalStreak, 5);
  assertEquals(result.graduated, false);
  assertEquals(result.nextReplyMode, "draft_only");
});

Deno.test("computeStreakTransition resets the streak on an edited approval", () => {
  const result = computeStreakTransition({ ...baseState, approvalStreak: 7 }, "approved_edited");
  assertEquals(result.nextApprovalStreak, 0);
  assertEquals(result.graduated, false);
});

Deno.test("computeStreakTransition resets the streak on rejection", () => {
  const result = computeStreakTransition({ ...baseState, approvalStreak: 9 }, "rejected");
  assertEquals(result.nextApprovalStreak, 0);
  assertEquals(result.graduated, false);
});

Deno.test("computeStreakTransition graduates to auto_reply when the target is reached", () => {
  const result = computeStreakTransition({ ...baseState, approvalStreak: 9 }, "approved_clean");
  assertEquals(result.nextApprovalStreak, 10);
  assertEquals(result.nextReplyMode, "auto_reply");
  assertEquals(result.graduated, true);
});

Deno.test("computeStreakTransition keeps counting once already auto_reply without re-graduating", () => {
  const result = computeStreakTransition(
    { approvalStreak: 12, autoSendStreakTarget: 10, replyMode: "auto_reply" },
    "approved_clean",
  );
  assertEquals(result.nextApprovalStreak, 13);
  assertEquals(result.graduated, false);
  assertEquals(result.nextReplyMode, "auto_reply");
});
