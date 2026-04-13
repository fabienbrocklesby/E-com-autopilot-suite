/**
 * Playbook engine types.
 * Mirrors the data model from docs/PLAYBOOK_ENGINE.md.
 */

// ─── Step definitions (stored in playbooks.steps JSONB) ───────────────────────

export interface ExtractStep {
  id: string;
  type: "extract";
  variables: string[];
}

export interface FindSheetRowStep {
  id: string;
  type: "find_sheet_row";
  match_attempts: Array<{ column: string; context_var: string }>;
}

export interface UpdateSheetStep {
  id: string;
  type: "update_sheet";
  row_var: string;
  updates: Array<{ column: string; value_or_var: string }>;
}

export interface AskCustomerStep {
  id: string;
  type: "ask_customer";
  message: string;
  on_reply_goto: string;
}

export interface BranchStep {
  id: string;
  type: "branch";
  condition: string;
  if_true: string;
  if_false: string;
}

export interface ManualApprovalStep {
  id: string;
  type: "manual_approval";
  reason: string;
  draft_template?: string;
  on_approve: string;
  on_reject: string;
}

export interface SendReplyStep {
  id: string;
  type: "send_reply";
  message: string | { from_template: string } | { ai_generate_using_category_voice: true };
}

export interface CompleteStep {
  id: string;
  type: "complete";
}

export interface EscalateStep {
  id: string;
  type: "escalate";
  reason: string;
}

export type PlaybookStep =
  | ExtractStep
  | FindSheetRowStep
  | UpdateSheetStep
  | AskCustomerStep
  | BranchStep
  | ManualApprovalStep
  | SendReplyStep
  | CompleteStep
  | EscalateStep;

export type StepType = PlaybookStep["type"];

// ─── Database row types ───────────────────────────────────────────────────────

export interface Playbook {
  id: number;
  workspace_id: number;
  category_id: number | null;
  name: string;
  plain_language_description: string | null;
  steps: PlaybookStep[];
  version: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PlaybookRun {
  id: number;
  workspace_id: number;
  thread_id: number;
  playbook_id: number;
  playbook_version: number;
  current_step_id: string | null;
  status: RunStatus;
  context: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export type RunStatus =
  | "running"
  | "waiting_for_customer"
  | "waiting_for_human"
  | "complete"
  | "failed"
  | "escalated";

export interface StepExecution {
  id: number;
  run_id: number;
  step_id: string;
  step_type: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  input: unknown;
  output: unknown;
  error: string | null;
  ai_calls: unknown;
  created_at: Date;
  completed_at: Date | null;
}

// ─── Handler interface ────────────────────────────────────────────────────────

export interface RunContext {
  run: PlaybookRun;
  playbook: Playbook;
  threadId: number;
  workspaceId: number;
  /** The full context bag — handlers read and write to this */
  variables: Record<string, unknown>;
  /** All messages on this thread, oldest first */
  messages: Array<{
    id: number;
    from_address: string;
    body_plain: string;
    direction: "inbound" | "outbound";
    received_at: Date;
    message_id_header: string | null;
  }>;
  /** The connected email address for sending */
  email: string;
  /** The Gmail thread ID */
  gmailThreadId: string;
  /** The thread subject */
  subject: string;
}

export type StepDecision =
  | { action: "advance" }
  | { action: "advance_to"; stepId: string }
  | { action: "pause"; status: "waiting_for_customer" | "waiting_for_human" }
  | { action: "complete" }
  | { action: "fail"; error: string };

export interface StepResult {
  decision: StepDecision;
  output?: Record<string, unknown>;
  contextUpdates?: Record<string, unknown>;
  aiCalls?: Array<{ model: string; prompt: string; response: string; tokens?: number }>;
}

export interface StepHandler {
  execute(step: PlaybookStep, ctx: RunContext): Promise<StepResult>;
}
