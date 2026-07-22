/**
 * Send reply handler - sends a reply to the customer and advances.
 * Preferred path: AI-drafted from goal + reference_context.
 * Fallback: literal message string (backward compat).
 */
import type { PlaybookStep, RunContext, SendReplyStep, StepHandler, StepResult } from "../types.ts";
import { sendReply } from "../../gmail.ts";
import { resolveReplyAddress } from "../../reply-address.ts";
import { composeReplyBody } from "../composer.ts";
import type { AiCall } from "../composer.ts";
import { isPresent } from "../context-utils.ts";

export const sendReplyHandler: StepHandler = {
  async execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult> {
    const sendStep = step as SendReplyStep;

    // Find the last inbound message for the reply-to address
    const lastInbound = [...ctx.messages].reverse().find((m) => m.direction === "inbound");
    if (!lastInbound) {
      return {
        decision: { action: "fail", error: "No inbound message found to reply to" },
      };
    }
    const replyAddress = resolveReplyAddress(lastInbound);

    let body: string;
    // AiCall matches StepResult.aiCalls' element shape exactly (see composer.ts) -
    // reused here instead of re-declared so this doesn't drift from that type again.
    let aiCalls: AiCall[] | undefined;

    const hasLiteralMessage = typeof sendStep.message === "string";
    const hasGoal = !!sendStep.goal;

    if (hasLiteralMessage && !hasGoal) {
      // Backward compat: literal template with variable interpolation
      body = interpolateTemplate(sendStep.message as string, ctx.variables);
    } else if (
      hasGoal ||
      (sendStep.message && typeof sendStep.message === "object" &&
        "ai_generate_using_category_voice" in (sendStep.message as object))
    ) {
      // AI-drafted path - composer owns prompt assembly (thread brief, capped
      // transcript, sign-off/voice rules) so this and ask_customer stop
      // maintaining their own divergent copies of the same context-building.
      // aiCall is kept in aiCalls below so playbook_step_executions.ai_calls
      // is unchanged by moving prompt construction into the composer.
      const goal = sendStep.goal ??
        "Write a helpful and contextual reply to close out this interaction";

      const referenceContext: Record<string, unknown> = {};
      for (const key of (sendStep.reference_context ?? [])) {
        if (isPresent(ctx.variables[key])) referenceContext[key] = ctx.variables[key];
      }

      const composed = await composeReplyBody({
        ctx,
        goal,
        voice: sendStep.voice_hint,
        requiredContext: [],
        priorSent: [],
        referenceContext,
      });
      body = composed.body;
      aiCalls = [composed.aiCall];
    } else {
      return {
        decision: { action: "fail", error: "send_reply: no message or goal provided" },
      };
    }

    const delaySec = typeof sendStep.delay_seconds === "number" && sendStep.delay_seconds > 0
      ? sendStep.delay_seconds
      : 0;

    if (delaySec > 0) {
      return {
        decision: { action: "pause", status: "waiting_to_send", delaySec },
        output: { action: "delayed_send", pending_send: body, delay_seconds: delaySec },
        aiCalls,
      };
    }

    const requireApproval = sendStep.require_approval === true ||
      ctx.playbook.reply_mode === "draft_only";

    if (requireApproval) {
      console.log(`[playbook] send_reply: reply held for approval for run ${ctx.run.id}`);
      return {
        decision: { action: "pause", status: "waiting_for_human" },
        output: {
          action: "pending_approval",
          pending_send: body,
          step_type: "send_reply",
          reply_to: replyAddress.address,
          reply_to_source: replyAddress.source,
        },
        aiCalls,
      };
    }

    await sendReply(
      ctx.email,
      ctx.gmailThreadId,
      ctx.subject,
      replyAddress.address,
      body,
      lastInbound.message_id_header,
      ctx.threadId,
      ctx.workspaceId,
    );

    console.log(`[playbook] send_reply: sent reply for run ${ctx.run.id}`);

    return {
      decision: { action: "advance" },
      output: {
        message_sent: body,
        reply_to: replyAddress.address,
        reply_to_source: replyAddress.source,
      },
      aiCalls,
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
