/**
 * Ask customer handler — AI-driven contextual message to gather missing info.
 * Falls back to literal message for backward compatibility.
 */
import type { StepHandler, StepResult, RunContext, PlaybookStep, AskCustomerStep } from "../types.ts";
import { sendReply } from "../../gmail.ts";
import { chatCompletion, getModel } from "../../ai.ts";
import { query, queryOne } from "../../../db/client.ts";

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

    // Backward compat: if no goal, send the literal message
    if (!askStep.goal) {
      const message = askStep.message ?? "";
      await sendReply(
        ctx.email,
        ctx.gmailThreadId,
        ctx.subject,
        lastInbound.from_address,
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

    // 1. Deterministic pre-check: do we already have all required vars?
    const missing = requiredContext.filter((v) => ctx.variables[v] == null);
    if (missing.length === 0) {
      console.log(`[playbook] ask_customer: all required context present, skipping send for run ${ctx.run.id}`);
      return {
        decision: { action: "advance_to", stepId: askStep.on_reply_goto },
        output: { action: "skipped", reason: "all required context present" },
      };
    }

    // 2. Load category writing_style
    const category = ctx.playbook.category_id
      ? await queryOne<{ writing_style: string | null }>(
          "SELECT writing_style FROM categories WHERE id = $1",
          [ctx.playbook.category_id],
        )
      : null;
    const voice = askStep.voice_hint ?? category?.writing_style ?? "friendly and professional";

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
    const transcript = recentMessages
      .map((m) => `${m.direction === "inbound" ? "CUSTOMER" : "US"}: ${m.body_plain.trim()}`)
      .join("\n\n");

    // 5. Format context
    const haveContext: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx.variables)) {
      if (v != null) haveContext[k] = v;
    }

    const model = await getModel(ctx.workspaceId);

    const systemPrompt = `You are helping a support agent handle an email thread. You write the next message to send to the customer.

TASK: ${askStep.goal}

VOICE: ${voice}

WHAT WE KNOW:
${JSON.stringify(haveContext, null, 2)}

WHAT WE STILL NEED:
${missing.join(", ")}

RECENT CONVERSATION:
${transcript}

PREVIOUS MESSAGES WE ALREADY SENT ON THIS THREAD (do NOT repeat these questions):
${previousMessages.length > 0 ? previousMessages.map((m) => `- ${m}`).join("\n") : "none"}

YOUR DECISION — return one of:
- {"action": "skip", "extracted": {"var1": "value", ...}, "reasoning": "..."} if the customer's messages already gave us what we need (even if loosely phrased)
- {"action": "escalate", "reason": "..."} if the customer is frustrated, confused, repeating themselves, or this conversation is going in circles
- {"action": "ask", "message": "..."} to write a brief, contextual message that references what the customer said and asks specifically for what's still missing

RULES:
- Do not repeat a question that appears in PREVIOUS MESSAGES WE ALREADY SENT.
- Acknowledge the customer's most recent message before asking for anything.
- Keep it brief — one short paragraph.
- Match the VOICE.
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

    let parsed: { action?: string; extracted?: Record<string, unknown>; reasoning?: string; reason?: string; message?: string };
    try {
      parsed = JSON.parse(response);
    } catch {
      return {
        decision: { action: "fail", error: "ask_customer AI returned invalid JSON" },
        aiCalls,
      };
    }

    if (parsed.action === "skip") {
      console.log(`[playbook] ask_customer: AI skipped (${parsed.reasoning}) for run ${ctx.run.id}`);
      return {
        decision: { action: "advance_to", stepId: askStep.on_reply_goto },
        contextUpdates: parsed.extracted ?? {},
        output: { action: "skipped", reasoning: parsed.reasoning },
        aiCalls,
      };
    }

    if (parsed.action === "escalate") {
      console.log(`[playbook] ask_customer: AI escalated — ${parsed.reason} for run ${ctx.run.id}`);
      return {
        decision: { action: "fail", error: `ask_customer escalated: ${parsed.reason}` },
        output: { action: "escalated", reason: parsed.reason },
        aiCalls,
      };
    }

    if (parsed.action === "ask" && parsed.message) {
      await sendReply(
        ctx.email,
        ctx.gmailThreadId,
        ctx.subject,
        lastInbound.from_address,
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
        },
        aiCalls,
      };
    }

    return {
      decision: { action: "fail", error: `ask_customer AI returned unexpected action: ${parsed.action}` },
      aiCalls,
    };
  },
};
