/**
 * Send reply handler — sends a reply to the customer and advances.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep, SendReplyStep } from "../types.ts";
import { sendReply } from "../../gmail.ts";

export const sendReplyHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const sendStep = step as SendReplyStep;

    // Resolve the message body
    let body: string;
    if (typeof sendStep.message === "string") {
      // Simple template — substitute context variables
      body = interpolateTemplate(sendStep.message, ctx.variables);
    } else {
      // AI-generated or from_template — not implemented in Phase 2
      return {
        decision: { action: "fail", error: "AI-generated and template messages not implemented yet" },
      };
    }

    // Find the last inbound message to get the reply-to address
    const lastInbound = [...ctx.messages].reverse().find((m) => m.direction === "inbound");
    if (!lastInbound) {
      return {
        decision: { action: "fail", error: "No inbound message found to reply to" },
      };
    }

    await sendReply(
      ctx.email,
      ctx.gmailThreadId,
      ctx.subject,
      lastInbound.from_address,
      body,
      lastInbound.message_id_header,
    );

    console.log(`[playbook] send_reply: sent reply for run ${ctx.run.id}`);

    return {
      decision: { action: "advance" },
      output: { message_sent: body },
    };
  },
};

/**
 * Replace {{variable_name}} placeholders with values from the context bag.
 */
function interpolateTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const val = variables[key];
    return val !== null && val !== undefined ? String(val) : "";
  });
}
