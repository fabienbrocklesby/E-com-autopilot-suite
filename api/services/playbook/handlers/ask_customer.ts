/**
 * Ask customer handler - AI-driven contextual message to gather missing info.
 * Falls back to literal message for backward compatibility.
 */
import type {
  AskCustomerStep,
  PlaybookStep,
  RunContext,
  StepHandler,
  StepResult,
} from "../types.ts";
import { sendReply } from "../../gmail.ts";
import { chatCompletion, getModel } from "../../ai.ts";
import { query } from "../../../db/client.ts";
import { formatTranscript } from "../../email-text.ts";
import { resolveReplyAddress } from "../../reply-address.ts";
import { isPresent } from "../context-utils.ts";

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
    const replyAddress = resolveReplyAddress(lastInbound);

    // Backward compat: if no goal, send the literal message
    if (!askStep.goal) {
      const message = askStep.message ?? "";
      const requireApprovalLegacy = askStep.require_approval === true ||
        ctx.playbook.reply_mode === "draft_only";

      if (requireApprovalLegacy) {
        console.log(
          `[playbook] ask_customer (legacy): reply held for approval for run ${ctx.run.id}`,
        );
        return {
          decision: { action: "pause", status: "waiting_for_human" },
          output: {
            action: "pending_approval",
            pending_send: message,
            on_reply_goto: askStep.on_reply_goto,
            step_type: "ask_customer",
          },
        };
      }

      await sendReply(
        ctx.email,
        ctx.gmailThreadId,
        ctx.subject,
        replyAddress.address,
        message,
        lastInbound.message_id_header,
        ctx.threadId,
        ctx.workspaceId,
      );
      console.log(`[playbook] ask_customer (legacy): sent literal message for run ${ctx.run.id}`);
      return {
        decision: { action: "pause", status: "waiting_for_customer" },
        output: { message_sent: message, on_reply_goto: askStep.on_reply_goto },
      };
    }

    // AI-driven path
    const requiredContext = askStep.required_context ?? [];

    // Routing semantics:
    //   - on_reply_goto: where to resume AFTER a customer reply triggers re-execution.
    //     Used only when this step actually paused for a customer reply.
    //   - "advance": sequential next step. Used when this step did its job and
    //     downstream steps should run.
    //
    // When required_context is already present, we are skipping the ask entirely.
    // We did not pause, no customer reply is pending, so on_reply_goto is irrelevant.
    // We must advance sequentially so that downstream steps (evaluate, etc.) execute.

    // 1. Deterministic pre-check: do we already have all required vars?
    const missing = requiredContext.filter((v) => !isPresent(ctx.variables[v]));
    if (missing.length === 0) {
      console.log(
        `[playbook] ask_customer: all required context present, skipping send for run ${ctx.run.id}`,
      );
      return {
        decision: { action: "advance" },
        output: {
          action: "skipped",
          reason: "all required context present",
          skipped_message_send: true,
        },
      };
    }

    // 2. Resolve writing voice: step-level override → playbook default → fallback
    const voice = askStep.voice_hint ?? (ctx.playbook.writing_style || "friendly and professional");

    // 3. Load previous ask_customer messages sent on this run
    const prevExecutions = await query<{ output: { message_sent?: string } | null }>(
      `SELECT output FROM playbook_step_executions
       WHERE run_id = $1 AND step_id = $2 AND status = 'success'
       ORDER BY created_at ASC`,
      [ctx.run.id, step.id],
    );
    const previousMessages = prevExecutions
      .map((e) => e.output?.message_sent)
      .filter((m): m is string => !!m);

    // 4. Recent conversation thread (last 5)
    const recentMessages = ctx.messages.slice(-5);
    const transcript = formatTranscript(recentMessages);

    // 5. Format context
    const haveContext: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx.variables)) {
      if (v != null) haveContext[k] = v;
    }

    const model = await getModel(ctx.workspaceId);

    const systemPrompt =
      `You are helping a support agent handle an email thread. You write the next message to send to the customer.

TASK: ${askStep.goal}

VOICE: ${voice}
${ctx.senderName ? `\nSIGN OFF AS: ${ctx.senderName}` : ""}
${
        ctx.storeProfile
          ? `\nSTORE CONTEXT (use naturally where relevant, do not mention robotically):\n${ctx.storeProfile}`
          : ""
      }

WHAT WE KNOW:
${JSON.stringify(haveContext, null, 2)}

WHAT WE STILL NEED:
${missing.join(", ")}

RECENT CONVERSATION:
${transcript}

PREVIOUS MESSAGES WE ALREADY SENT ON THIS THREAD (do NOT repeat these questions):
${previousMessages.length > 0 ? previousMessages.map((m) => `- ${m}`).join("\n") : "none"}

YOUR DECISION - return one of:
- {"action": "skip", "extracted": {"var1": "value", ...}, "reasoning": "..."} if the customer's messages already gave us what we need (even if loosely phrased)
- {"action": "escalate", "reason": "..."} if the customer is frustrated, confused, repeating themselves, or this conversation is going in circles
- {"action": "ask", "message": "..."} to write a brief, contextual message that references what the customer said and asks specifically for what's still missing

RULES:
- Do not repeat a question that appears in PREVIOUS MESSAGES WE ALREADY SENT.
- Acknowledge the customer's most recent message before asking for anything.
- Keep it brief - one short paragraph.
- Match the VOICE.${
        ctx.senderName
          ? `\n- Sign off using the exact name: ${ctx.senderName}`
          : "\n- Do not include a name placeholder."
      }
- NEVER use placeholder text like [Your Name], [Name], or any text in square brackets.
- Output JSON only. No preamble, no markdown.`;

    const response = await chatCompletion(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Decide and respond." },
      ],
      model,
      { type: "json_object" },
    );

    const aiCalls = [{ model, prompt: systemPrompt, response, tokens: undefined }];

    let parsed: {
      action?: string;
      extracted?: Record<string, unknown>;
      reasoning?: string;
      reason?: string;
      message?: string;
    };
    try {
      parsed = JSON.parse(response);
    } catch {
      return {
        decision: { action: "fail", error: "ask_customer AI returned invalid JSON" },
        aiCalls,
      };
    }

    if (parsed.action === "skip") {
      console.log(
        `[playbook] ask_customer: AI skipped (${parsed.reasoning}) for run ${ctx.run.id}`,
      );
      return {
        decision: { action: "advance" },
        contextUpdates: parsed.extracted ?? {},
        output: {
          action: "skipped",
          reasoning: parsed.reasoning,
          extracted_keys: Object.keys(parsed.extracted ?? {}),
        },
        aiCalls,
      };
    }

    if (parsed.action === "escalate") {
      console.log(`[playbook] ask_customer: AI escalated - ${parsed.reason} for run ${ctx.run.id}`);
      return {
        decision: { action: "fail", error: `ask_customer escalated: ${parsed.reason}` },
        output: { action: "escalated", reason: parsed.reason },
        aiCalls,
      };
    }

    if (parsed.action === "ask" && parsed.message) {
      const requireApproval = askStep.require_approval === true ||
        ctx.playbook.reply_mode === "draft_only";

      if (requireApproval) {
        console.log(`[playbook] ask_customer: reply held for approval for run ${ctx.run.id}`);
        return {
          decision: { action: "pause", status: "waiting_for_human" },
          output: {
            action: "pending_approval",
            pending_send: parsed.message,
            on_reply_goto: askStep.on_reply_goto,
            step_type: "ask_customer",
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
        parsed.message,
        lastInbound.message_id_header,
        ctx.threadId,
        ctx.workspaceId,
      );
      console.log(`[playbook] ask_customer: AI-drafted message sent for run ${ctx.run.id}`);
      return {
        decision: { action: "pause", status: "waiting_for_customer" },
        output: {
          action: "asked",
          message_sent: parsed.message,
          on_reply_goto: askStep.on_reply_goto,
          reply_to: replyAddress.address,
          reply_to_source: replyAddress.source,
        },
        aiCalls,
      };
    }

    return {
      decision: {
        action: "fail",
        error: `ask_customer AI returned unexpected action: ${parsed.action}`,
      },
      aiCalls,
    };
  },
};
