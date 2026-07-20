/**
 * Step handler registry - maps step type strings to handler implementations.
 *
 * The map is built lazily inside getHandler, not as a top-level const, because
 * ask_customer.ts and send_reply.ts import gmail.ts, which imports
 * executor.ts, which imports this file - a real circular import. A top-level
 * object literal referencing e.g. askCustomerHandler throws a TDZ
 * ReferenceError whenever a module further round that cycle (ask_customer.ts
 * itself, or a test that imports it directly) becomes the entry point of the
 * module graph, because this file's top level would then run before
 * ask_customer.ts finishes its own. Deferring the reference into a function
 * body sidesteps this: getHandler is only ever called at run time, by which
 * point the whole graph has finished loading regardless of entry point.
 */
import type { StepHandler, StepType } from "./types.ts";
import { extractHandler } from "./handlers/extract.ts";
import { branchHandler } from "./handlers/branch.ts";
import { evaluateHandler } from "./handlers/evaluate.ts";
import { triageHandler } from "./handlers/triage.ts";
import { askCustomerHandler } from "./handlers/ask_customer.ts";
import { sendReplyHandler } from "./handlers/send_reply.ts";
import { completeHandler } from "./handlers/complete.ts";
import { escalateHandler } from "./handlers/escalate.ts";
import { manualApprovalHandler } from "./handlers/manual_approval.ts";
import { findSheetRowHandler } from "./handlers/find_sheet_row.ts";
import { updateSheetHandler } from "./handlers/update_sheet.ts";

let handlers: Record<string, StepHandler> | null = null;

function buildHandlers(): Record<string, StepHandler> {
  return {
    extract: extractHandler,
    branch: branchHandler,
    evaluate: evaluateHandler,
    triage: triageHandler,
    ask_customer: askCustomerHandler,
    send_reply: sendReplyHandler,
    complete: completeHandler,
    escalate: escalateHandler,
    manual_approval: manualApprovalHandler,
    find_sheet_row: findSheetRowHandler,
    update_sheet: updateSheetHandler,
  };
}

export function getHandler(stepType: StepType): StepHandler {
  handlers ??= buildHandlers();
  const handler = handlers[stepType];
  if (!handler) {
    throw new Error(`No handler registered for step type: ${stepType}`);
  }
  return handler;
}
