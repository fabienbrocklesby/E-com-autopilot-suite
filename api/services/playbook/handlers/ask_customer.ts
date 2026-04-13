/**
 * Ask customer handler — sends a question to the customer and pauses
 * the run until they reply.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep, AskCustomerStep } from "../types.ts";
import { sendReply } from "../../gmail.ts";

export const askCustomerHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const askStep = step as AskCustomerStep;

    // Find the last inbound message to get the reply-to address
    const lastInbound = [...ctx.messages].reverse().find((m) => m.direction === "inbound");
    if (!lastInbound) {
      return {
        decision: { action: "fail", error: "No inbound message found to reply to" },
      };
    }

    // Send the question as a reply
    await sendReply(
      ctx.email,
      ctx.gmailThreadId,
      ctx.subject,
      lastInbound.from_address,
      askStep.message,
      lastInbound.message_id_header,
    );

    console.log(`[playbook] ask_customer: sent question for run ${ctx.run.id}, waiting for reply`);

    return {
      decision: { action: "pause", status: "waiting_for_customer" },
      output: { message_sent: askStep.message, on_reply_goto: askStep.on_reply_goto },
    };
  },
};
