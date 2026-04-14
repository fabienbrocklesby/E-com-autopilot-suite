/**
 * Plain-language → structured steps parser.
 * Builds a context-aware system prompt, calls the AI, validates, and returns steps.
 */
import { query, queryOne } from "../../db/client.ts";
import { chatCompletion } from "../ai.ts";
import type { PlaybookStep } from "./types.ts";

const VALID_STEP_TYPES = [
  "extract",
  "find_sheet_row",
  "update_sheet",
  "ask_customer",
  "branch",
  "evaluate",
  "manual_approval",
  "send_reply",
  "complete",
  "escalate",
] as const;

const STEP_TYPE_REFERENCE = `Available step types and their required fields (return JSON exactly as shown):

1. extract — AI reads the email thread and pulls named variables into context
   { "id": "extract_1", "type": "extract", "variables": ["order_number", "customer_email"] }

2. find_sheet_row — Search a Google Sheet for a row matching a context variable
   { "id": "find_1", "type": "find_sheet_row", "match_attempts": [{"column": "Order Number", "context_var": "order_number"}, {"column": "Email", "context_var": "customer_email"}] }

3. update_sheet — Write values to columns on a found row
   { "id": "update_1", "type": "update_sheet", "row_var": "row_number", "updates": [{"column": "Status", "value_or_var": "Refund Requested"}, {"column": "Reason", "value_or_var": "{refund_reason}"}] }

4. ask_customer — AI-driven: sends a contextual message to gather missing info. The AI writes the actual message at runtime based on goal + context. Do NOT write the literal message here.
   { "id": "ask_1", "type": "ask_customer", "goal": "Get the order number and reason for refund so we can process it", "required_context": ["order_number", "refund_reason"], "on_reply_goto": "extract_1" }

5. branch — Deterministic routing on a simple condition. Use ONLY for literal null-checks or simple comparisons. Do NOT use for judgment calls about conversation state.
   { "id": "branch_1", "type": "branch", "condition": "context.order_number != null", "if_true": "find_1", "if_false": "ask_1" }
   Condition patterns: "context.VAR != null" | "context.VAR == null" | "context.VAR" (truthy)

6. evaluate — AI-driven three-way routing. Use when the decision involves judgment: "do we have enough info?", "is the conversation stuck?", "is something wrong?". Use this instead of branch for anything requiring judgment.
   { "id": "evaluate_1", "type": "evaluate", "goal": "Do we have a sheet row and a refund reason to proceed?", "required_context": ["row_number", "refund_reason"], "if_satisfied_goto": "update_1", "if_missing_goto": "ask_1", "if_escalate_goto": "escalate_1" }

7. manual_approval — Pause and wait for a human. Set capture_input: true when the human is performing an external action (processing a refund, fixing an order, etc.) and you need their notes or transaction ID.
   { "id": "approval_1", "type": "manual_approval", "reason": "Process this refund in Stripe. Enter transaction ID and amount when done.", "capture_input": true, "input_prompt": "Stripe transaction ID and amount (e.g. 'txn_abc123, $89.99')", "input_context_key": "refund_notes", "on_approve": "update_2", "on_reject": "escalate_1" }
   For simple sign-off (no action required): { "id": "approval_1", "type": "manual_approval", "reason": "Review this before sending", "on_approve": "send_1", "on_reject": "escalate_1" }

8. send_reply — Send a reply to the customer. Prefer goal + reference_context for AI-drafted contextual replies. Only use literal message for very simple fixed text.
   AI-drafted (preferred): { "id": "send_1", "type": "send_reply", "goal": "Confirm the refund is on its way and mention the amount", "reference_context": ["refund_notes", "customer_name"] }
   Literal (only for simple fixed text): { "id": "send_1", "type": "send_reply", "message": "Your order has been received." }

9. complete — End the run cleanly
   { "id": "complete_1", "type": "complete" }

10. escalate — Flag for human review and end the run
    { "id": "escalate_1", "type": "escalate", "reason": "Could not find order in sheet" }`;


export interface ParseResult {
  steps: PlaybookStep[];
  warnings: string[];
}

export async function parsePlaybook(
  description: string,
  workspaceId: number,
): Promise<ParseResult> {
  const workspace = await queryOne<{ sheet_id: string | null; sheet_name: string }>(
    "SELECT sheet_id, sheet_name FROM workspaces WHERE id = $1",
    [workspaceId],
  );

  const categories = await query<{ id: number; name: string }>(
    "SELECT id, name FROM categories WHERE workspace_id = $1 ORDER BY name",
    [workspaceId],
  );

  const sheetContext = workspace?.sheet_id
    ? `The workspace has a Google Sheet named "${workspace.sheet_name}". Use realistic e-commerce column names (e.g. "Order Number", "Email", "Name", "Status", "Refund Reason", "Amount").`
    : "No Google Sheet configured yet. You can still include find_sheet_row and update_sheet steps with sensible column names.";

  const categoryContext = categories.length > 0
    ? `\nKnown categories: ${categories.map((c) => c.name).join(", ")}.`
    : "";

  const systemPrompt = `You are a playbook step generator for an e-commerce email automation tool.
Convert a plain-language description of an email handling process into a JSON array of structured steps.

${STEP_TYPE_REFERENCE}

Rules:
- Each step id must be unique, short, and descriptive in snake_case (e.g. "extract_1", "ask_order_1").
- Steps run sequentially unless a branch/evaluate redirects flow.
- ask_customer "on_reply_goto" must be an id that exists in the steps array.
- branch "if_true" and "if_false" must be ids that exist in the steps array.
- evaluate "if_satisfied_goto", "if_missing_goto", and "if_escalate_goto" must be ids that exist in the steps array.
- manual_approval "on_approve" and "on_reject" must be ids in the steps array.
- Always end with "complete" or "escalate".
- Return ONLY a JSON object: { "steps": [...] }. No explanation. No markdown fences.

Guidance on when to use each routing step:
- Use "evaluate" for decisions that require judgment: "do we have enough info?", "is this stuck?", "is something off?"
- Use "branch" ONLY for simple literal checks: "is variable X null?", "is variable X equal to some value?"
- Never use "branch" for conversation-state decisions — use "evaluate"

Guidance on ask_customer:
- Always use the new format with "goal" and "required_context". Never write a literal message in the playbook.
- "goal" should describe WHAT we need and WHY, in one sentence.

Guidance on send_reply:
- Almost always use "goal" + "reference_context" for AI-drafted contextual replies.
- Only use "message" for very simple fixed text (e.g. "Your request has been received.").
- "reference_context" lists variable names whose values should naturally appear in the reply.

Guidance on manual_approval:
- Set "capture_input": true whenever the human is taking an external action (processing payment, fixing order, contacting supplier).
- "input_prompt" should tell the human exactly what to enter (e.g. "Stripe transaction ID and amount").
- "input_context_key" names where the captured text lands in context (default "human_notes").
${sheetContext}${categoryContext}`;

  const content = await chatCompletion(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Convert this to steps:\n\n${description}` },
    ],
    "gpt-4o",
    { type: "json_object" },
  );

  let parsed: { steps?: unknown[] };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("AI returned invalid JSON");
  }

  if (!Array.isArray(parsed.steps)) {
    throw new Error("AI response missing 'steps' array");
  }

  const warnings: string[] = [];
  const validatedSteps: PlaybookStep[] = [];

  for (const step of parsed.steps) {
    if (typeof step !== "object" || step === null) {
      warnings.push(`Skipped non-object step`);
      continue;
    }
    const s = step as Record<string, unknown>;
    if (!s.id || typeof s.id !== "string") {
      warnings.push(`Step missing 'id' field: ${JSON.stringify(s).slice(0, 80)}`);
      continue;
    }
    if (!s.type || !VALID_STEP_TYPES.includes(s.type as typeof VALID_STEP_TYPES[number])) {
      warnings.push(`Step "${s.id}" has unknown type: "${s.type}"`);
      continue;
    }
    validatedSteps.push(s as unknown as PlaybookStep);
  }

  // Reference validation
  const stepIds = new Set(validatedSteps.map((s) => s.id));
  for (const step of validatedSteps) {
    if (step.type === "ask_customer") {
      const s = step as { on_reply_goto?: string };
      if (s.on_reply_goto && !stepIds.has(s.on_reply_goto)) {
        warnings.push(`Step "${step.id}": on_reply_goto "${s.on_reply_goto}" not found`);
      }
    }
    if (step.type === "branch") {
      const s = step as { if_true?: string; if_false?: string };
      if (s.if_true && !stepIds.has(s.if_true)) {
        warnings.push(`Step "${step.id}": if_true "${s.if_true}" not found`);
      }
      if (s.if_false && !stepIds.has(s.if_false)) {
        warnings.push(`Step "${step.id}": if_false "${s.if_false}" not found`);
      }
    }
    if (step.type === "evaluate") {
      const s = step as { if_satisfied_goto?: string; if_missing_goto?: string; if_escalate_goto?: string };
      if (s.if_satisfied_goto && !stepIds.has(s.if_satisfied_goto)) {
        warnings.push(`Step "${step.id}": if_satisfied_goto "${s.if_satisfied_goto}" not found`);
      }
      if (s.if_missing_goto && !stepIds.has(s.if_missing_goto)) {
        warnings.push(`Step "${step.id}": if_missing_goto "${s.if_missing_goto}" not found`);
      }
      if (s.if_escalate_goto && !stepIds.has(s.if_escalate_goto)) {
        warnings.push(`Step "${step.id}": if_escalate_goto "${s.if_escalate_goto}" not found`);
      }
    }
    if (step.type === "manual_approval") {
      const s = step as { on_approve?: string; on_reject?: string };
      if (s.on_approve && !stepIds.has(s.on_approve)) {
        warnings.push(`Step "${step.id}": on_approve "${s.on_approve}" not found`);
      }
      if (s.on_reject && !stepIds.has(s.on_reject)) {
        warnings.push(`Step "${step.id}": on_reject "${s.on_reject}" not found`);
      }
    }
  }

  return { steps: validatedSteps, warnings };
}
