/**
 * Step handler registry — maps step type strings to handler implementations.
 */
import type { StepHandler, StepType } from "./types.ts";
import { extractHandler } from "./handlers/extract.ts";
import { branchHandler } from "./handlers/branch.ts";
import { evaluateHandler } from "./handlers/evaluate.ts";
import { askCustomerHandler } from "./handlers/ask_customer.ts";
import { sendReplyHandler } from "./handlers/send_reply.ts";
import { completeHandler } from "./handlers/complete.ts";
import { escalateHandler } from "./handlers/escalate.ts";
import { manualApprovalHandler } from "./handlers/manual_approval.ts";
import { findSheetRowHandler } from "./handlers/find_sheet_row.ts";
import { updateSheetHandler } from "./handlers/update_sheet.ts";

const handlers: Record<string, StepHandler> = {
  extract: extractHandler,
  branch: branchHandler,
  evaluate: evaluateHandler,
  ask_customer: askCustomerHandler,
  send_reply: sendReplyHandler,
  complete: completeHandler,
  escalate: escalateHandler,
  manual_approval: manualApprovalHandler,
  find_sheet_row: findSheetRowHandler,
  update_sheet: updateSheetHandler,
};

export function getHandler(stepType: StepType): StepHandler {
  const handler = handlers[stepType];
  if (!handler) {
    throw new Error(`No handler registered for step type: ${stepType}`);
  }
  return handler;
}
