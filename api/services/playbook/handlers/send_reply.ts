/**
 * Send reply handler - sends a reply to the customer and advances.
 * Preferred path: AI-drafted from goal + reference_context.
 * Fallback: literal message string (backward compat).
 */
import type { PlaybookStep, RunContext, SendReplyStep, StepHandler, StepResult } from "../types.ts";
import { sendReply } from "../../gmail.ts";
import { chatCompletion, getModel } from "../../ai.ts";
import { formatTranscript } from "../../email-text.ts";

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

    let body: string;
    let aiCalls:
      | Array<{ model: string; prompt: string; response: string; tokens: undefined }>
      | undefined;

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
      // AI-drafted path
      // Resolve writing voice: step-level override → playbook default → fallback
      const voice = sendStep.voice_hint ??
        (ctx.playbook.writing_style || "friendly and professional");
      const goal = sendStep.goal ??
        "Write a helpful and contextual reply to close out this interaction";

      // Build reference context values
      const refs: Record<string, unknown> = {};
      for (const key of (sendStep.reference_context ?? [])) {
        if (ctx.variables[key] != null) refs[key] = ctx.variables[key];
      }

      const recentMessages = ctx.messages.slice(-3);
      const transcript = formatTranscript(recentMessages);

      const model = await getModel(ctx.workspaceId);

      const systemPrompt = `Write a brief reply to this email thread.

GOAL: ${goal}

VOICE: ${voice}
${ctx.senderName ? `\nSIGN OFF AS: ${ctx.senderName}` : ""}
${
        ctx.storeProfile
          ? `\nSTORE CONTEXT (use naturally where relevant, do not mention robotically):\n${ctx.storeProfile}`
          : ""
      }

MUST REFERENCE NATURALLY (do not list robotically - weave into the message):
${Object.keys(refs).length > 0 ? JSON.stringify(refs, null, 2) : "no specific values required"}

FULL CONTEXT FOR THIS RUN:
${JSON.stringify(ctx.variables, null, 2)}

RECENT THREAD:
${transcript}

RULES:
- Brief. One short paragraph unless the customer asked multiple things.
- Match the VOICE. Don't sound corporate unless the voice says so.
- Reference facts from context naturally (e.g. the amount, order number) - don't list them like a form.
- Don't start with "Thank you for" unless the voice specifically calls for it.${
        ctx.senderName
          ? `\n- Sign off using the exact name: ${ctx.senderName}`
          : "\n- Do not include a sign-off or name placeholder."
      }
- NEVER use placeholder text like [Your Name], [Name], or any text in square brackets.
- Return ONLY the message body. No JSON, no subject line, no surrounding quotes.`;

      const response = await chatCompletion(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: "Write the reply." },
        ],
        model,
      );

      body = response.trim();
      aiCalls = [{ model, prompt: systemPrompt, response, tokens: undefined }];
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
        },
        aiCalls,
      };
    }

    await sendReply(
      ctx.email,
      ctx.gmailThreadId,
      ctx.subject,
      lastInbound.from_address,
      body,
      lastInbound.message_id_header,
      ctx.threadId,
      ctx.workspaceId,
    );

    console.log(`[playbook] send_reply: sent reply for run ${ctx.run.id}`);

    return {
      decision: { action: "advance" },
      output: { message_sent: body },
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
