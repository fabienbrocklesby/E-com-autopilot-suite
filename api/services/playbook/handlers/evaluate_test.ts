import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveEvaluateEscalateReason } from "./evaluate.ts";

Deno.test("resolveEvaluateEscalateReason uses the AI's stated reason", () => {
  assertEquals(
    resolveEvaluateEscalateReason("order_number looks like a placeholder, not a real value"),
    "order_number looks like a placeholder, not a real value",
  );
});

Deno.test("resolveEvaluateEscalateReason falls back when the AI gave no reason", () => {
  assertEquals(
    resolveEvaluateEscalateReason(undefined),
    "evaluate AI escalated without a stated reason",
  );
});
