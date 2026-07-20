import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveAskCustomerEscalateReason } from "./ask_customer.ts";

Deno.test("resolveAskCustomerEscalateReason uses the AI's stated reason", () => {
  assertEquals(
    resolveAskCustomerEscalateReason("Customer is repeating themselves and getting frustrated"),
    "Customer is repeating themselves and getting frustrated",
  );
});

Deno.test("resolveAskCustomerEscalateReason falls back when the AI gave no reason", () => {
  assertEquals(
    resolveAskCustomerEscalateReason(undefined),
    "ask_customer AI escalated without a stated reason",
  );
});

Deno.test("resolveAskCustomerEscalateReason falls back on a blank reason", () => {
  assertEquals(
    resolveAskCustomerEscalateReason("   "),
    "ask_customer AI escalated without a stated reason",
  );
});
