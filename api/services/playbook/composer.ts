/**
 * Unified reply composer - the single place that assembles prompt context
 * for anything writing a customer-facing message. Replaces the divergent
 * prompt builders that used to live separately in ask_customer.ts and
 * send_reply.ts, which had quietly drifted (different transcript windows,
 * different presence checks) and produced inconsistent reply quality.
 */
import type { RunContext } from "./types.ts";
import { chatCompletion, getModel } from "../ai.ts";
import { ensureBriefSummary, getThreadBrief } from "./brief.ts";
import type { ThreadBrief } from "./brief.ts";
import { formatBriefBlock, formatCappedTranscript, isPresent } from "./context-utils.ts";

export type ComposerInputs = {
  ctx: RunContext;
  goal: string;
  voice: string | undefined;
  requiredContext: string[];
  priorSent: string[];
};

export type AskDecision =
  | { action: "ask"; message: string }
  | { action: "skip"; extracted: Record<string, unknown> }
  | { action: "escalate"; reason: string };

// Reuses the exact element shape StepResult.aiCalls already carries in
// types.ts (`{ model, prompt, response, tokens: undefined }`, used by every
// AI-calling handler today) so ask_customer.ts and send_reply.ts can keep
// populating playbook_step_executions.ai_calls after moving their prompt
// building into this module - the audit trail must not regress.
export type AiCall = { model: string; prompt: string; response: string; tokens?: number };

/**
 * Pure prompt-context assembly, unit-testable without touching Postgres or
 * OpenAI. buildComposerContext (below) is the DB/AI-touching entry point
 * later tasks call; this export exists only so the assembly logic itself
 * gets a real failing-test-first cycle, mirroring the resolveTriageDecision
 * / triageHandler split already used in triage.ts.
 */
export function assembleComposerContext(
  inputs: ComposerInputs,
  brief: ThreadBrief,
  summary: string | null,
): string {
  const { ctx, requiredContext, priorSent } = inputs;
  const sections: string[] = [];

  if (ctx.senderName) {
    sections.push(`SIGN OFF AS: ${ctx.senderName}`);
  }

  if (ctx.storeProfile) {
    sections.push(
      `STORE CONTEXT (use naturally where relevant, do not mention robotically):\n${ctx.storeProfile}`,
    );
  }

  // Delegates to formatBriefBlock, the same renderer evaluate.ts and triage.ts
  // use, instead of hand-rolling a second THREAD BRIEF format here - this was
  // the exact prompt drift this composer exists to eliminate. Omits the
  // block entirely when the brief has neither facts nor a summary yet.
  const briefBlock = formatBriefBlock(brief);
  if (briefBlock) {
    sections.push(briefBlock);
  }

  const haveContext: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx.variables)) {
    if (isPresent(value)) haveContext[key] = value;
  }
  sections.push(`WHAT WE KNOW:\n${JSON.stringify(haveContext, null, 2)}`);

  const missing = requiredContext.filter((key) => !isPresent(ctx.variables[key]));
  sections.push(
    `WHAT WE STILL NEED:\n${
      missing.length > 0 ? missing.join(", ") : "nothing - all required context is present"
    }`,
  );

  sections.push(`THREAD TRANSCRIPT:\n${formatCappedTranscript(ctx.messages, summary)}`);

  sections.push(
    `PREVIOUS MESSAGES WE SENT (do NOT repeat these):\n${
      priorSent.length > 0 ? priorSent.map((m) => `- ${m}`).join("\n") : "none"
    }`,
  );

  return sections.join("\n\n");
}

/**
 * Fetch the thread brief and summary, then assemble the shared prompt
 * context both composeAskDecision and composeReplyBody build their
 * decision-specific system prompt around.
 */
export async function buildComposerContext(inputs: ComposerInputs): Promise<string> {
  const { ctx } = inputs;
  const brief = await getThreadBrief(ctx.threadId);
  const summary = await ensureBriefSummary(ctx.workspaceId, ctx.threadId, ctx.messages);
  return assembleComposerContext(inputs, brief, summary);
}

/**
 * Decide what to do about a customer thread that's missing required
 * context: skip the ask (the answer was already in the conversation),
 * escalate (the thread has gone in circles), or ask (write the next
 * question). Preserves ask_customer's existing decision rules and
 * anti-repetition instructions - only the context assembly moved.
 */
export async function composeAskDecision(
  inputs: ComposerInputs,
): Promise<{ decision: AskDecision; aiCall: AiCall }> {
  const { ctx, goal, voice } = inputs;
  const composerContext = await buildComposerContext(inputs);
  const resolvedVoice = voice ?? (ctx.playbook.writing_style || "friendly and professional");

  const systemPrompt =
    `You are helping a support agent handle an email thread. You write the next message to send to the customer.

TASK: ${goal}

VOICE: ${resolvedVoice}

${composerContext}

YOUR DECISION - return one of:
- {"action": "skip", "extracted": {"var1": "value", ...}, "reasoning": "..."} if the customer's messages already gave us what we need (even if loosely phrased)
- {"action": "escalate", "reason": "..."} if the customer is frustrated, confused, repeating themselves, or this conversation is going in circles
- {"action": "ask", "message": "..."} to write a brief, contextual message that references what the customer said and asks specifically for what's still missing

RULES:
- Do not repeat a question that appears in PREVIOUS MESSAGES WE SENT.
- Acknowledge the customer's most recent message before asking for anything.
- Keep it brief - one short paragraph.
- Match the VOICE.${
      ctx.senderName
        ? `\n- Sign off using the exact name: ${ctx.senderName}`
        : "\n- Do not include a name placeholder."
    }
- NEVER use placeholder text like [Your Name], [Name], or any text in square brackets.
- Output JSON only. No preamble, no markdown.`;

  const model = await getModel(ctx.workspaceId);
  const response = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Decide and respond." },
    ],
    model,
    { type: "json_object" },
  );

  const aiCall: AiCall = { model, prompt: systemPrompt, response, tokens: undefined };

  let parsed: {
    action?: string;
    extracted?: Record<string, unknown>;
    reason?: string;
    message?: string;
  };
  try {
    parsed = JSON.parse(response);
  } catch {
    // Malformed JSON goes to a human rather than throwing: a thrown AppError(502)
    // would be picked up by the executor's retriable-error check and retried as
    // if it were a transient upstream failure, when the real cause is a garbled
    // model response that won't fix itself on retry. Returning here (instead of
    // throwing) also keeps aiCall in the audit trail for the one response most
    // worth inspecting.
    return {
      decision: { action: "escalate", reason: "The assistant returned an unreadable response" },
      aiCall,
    };
  }

  if (parsed.action === "skip") {
    return { decision: { action: "skip", extracted: parsed.extracted ?? {} }, aiCall };
  }
  if (parsed.action === "escalate") {
    return {
      decision: { action: "escalate", reason: parsed.reason ?? "AI escalated without a reason" },
      aiCall,
    };
  }
  if (parsed.action === "ask" && parsed.message) {
    return { decision: { action: "ask", message: parsed.message }, aiCall };
  }

  // Unexpected/unrecognised action - same reasoning as the parse-failure case
  // above: escalate to a human with the aiCall preserved, don't throw a
  // retriable error for a response shape that retrying won't fix.
  return {
    decision: { action: "escalate", reason: "The assistant returned an unreadable response" },
    aiCall,
  };
}

/**
 * Draft the reply body for a send_reply step. Preserves send_reply's
 * existing voice/sign-off/no-placeholder rules - only the context assembly
 * moved into buildComposerContext.
 */
export async function composeReplyBody(
  inputs: ComposerInputs & { referenceContext: Record<string, unknown> },
): Promise<{ body: string; aiCall: AiCall }> {
  const { ctx, goal, voice, referenceContext } = inputs;
  const composerContext = await buildComposerContext(inputs);
  const resolvedVoice = voice ?? (ctx.playbook.writing_style || "friendly and professional");

  const systemPrompt = `Write a brief reply to this email thread.

GOAL: ${goal}

VOICE: ${resolvedVoice}

MUST REFERENCE NATURALLY (do not list robotically - weave into the message):
${
    Object.keys(referenceContext).length > 0
      ? JSON.stringify(referenceContext, null, 2)
      : "no specific values required"
  }

${composerContext}

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

  const model = await getModel(ctx.workspaceId);
  const response = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Write the reply." },
    ],
    model,
  );

  const body = response.trim();
  const aiCall: AiCall = { model, prompt: systemPrompt, response, tokens: undefined };
  return { body, aiCall };
}
