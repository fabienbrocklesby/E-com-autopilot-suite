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
import { query } from "../../../db/client.ts";
import { resolveReplyAddress } from "../../reply-address.ts";
import { composeAskDecision } from "../composer.ts";
import { isPresent } from "../context-utils.ts";

/**
 * Maps the AI's raw escalate reason to the text that becomes the run's
 * escalation_reason. Extracted as a pure function so it is unit-testable
 * without the chatCompletion call that produces `decision` in the first
 * place. composeAskDecision's AskDecision escalate variant already types
 * `reason` as a required string (it defaults malformed AI responses to a
 * fallback message itself), so this is a second, defensive layer that only
 * bites if that string is present but blank.
 */
export function resolveAskCustomerEscalateReason(reason: string | undefined): string {
  return reason && reason.trim()
    ? reason
    : "ask_customer AI escalated without a stated reason";
}

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

    // 2. Load previous ask_customer messages sent on this run (anti-repetition)
    const prevExecutions = await query<{ output: { message_sent?: string } | null }>(
      `SELECT output FROM playbook_step_executions
       WHERE run_id = $1 AND step_id = $2 AND status = 'success'
       ORDER BY created_at ASC`,
      [ctx.run.id, step.id],
    );
    const previousMessages = prevExecutions
      .map((e) => e.output?.message_sent)
      .filter((m): m is string => !!m);

    // 3. Ask the composer to decide: skip, escalate, or ask. It owns prompt
    // assembly (thread brief, capped transcript, WHAT WE KNOW/STILL NEED) so
    // ask_customer and send_reply stop maintaining their own divergent copies.
    // aiCall is threaded straight into StepResult.aiCalls below so the
    // playbook_step_executions.ai_calls audit trail is unchanged by moving
    // prompt construction into the composer.
    const { decision, aiCall } = await composeAskDecision({
      ctx,
      goal: askStep.goal,
      voice: askStep.voice_hint,
      requiredContext,
      priorSent: previousMessages,
    });
    const aiCalls = [aiCall];

    if (decision.action === "skip") {
      console.log(`[playbook] ask_customer: AI skipped for run ${ctx.run.id}`);
      return {
        decision: { action: "advance" },
        contextUpdates: decision.extracted,
        output: {
          action: "skipped",
          extracted_keys: Object.keys(decision.extracted),
        },
        aiCalls,
      };
    }

    if (decision.action === "escalate") {
      const reason = resolveAskCustomerEscalateReason(decision.reason);
      console.log(`[playbook] ask_customer: AI escalated - ${reason} for run ${ctx.run.id}`);
      return {
        decision: { action: "escalate", reason },
        output: { action: "escalated", reason },
        aiCalls,
      };
    }

    // decision.action === "ask"
    const requireApproval = askStep.require_approval === true ||
      ctx.playbook.reply_mode === "draft_only";

    if (requireApproval) {
      console.log(`[playbook] ask_customer: reply held for approval for run ${ctx.run.id}`);
      return {
        decision: { action: "pause", status: "waiting_for_human" },
        output: {
          action: "pending_approval",
          pending_send: decision.message,
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
      decision.message,
      lastInbound.message_id_header,
      ctx.threadId,
      ctx.workspaceId,
    );
    console.log(`[playbook] ask_customer: AI-drafted message sent for run ${ctx.run.id}`);
    return {
      decision: { action: "pause", status: "waiting_for_customer" },
      output: {
        action: "asked",
        message_sent: decision.message,
        on_reply_goto: askStep.on_reply_goto,
        reply_to: replyAddress.address,
        reply_to_source: replyAddress.source,
      },
      aiCalls,
    };
  },
};
