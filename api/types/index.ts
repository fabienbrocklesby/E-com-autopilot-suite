// Shared TypeScript types for the email automation dashboard API.

// ─── Database row types ───────────────────────────────────────────────────────

export interface Workspace {
  id: number;
  name: string;
  gmail_address: string | null;
  sheet_id: string | null;
  sheet_name: string;
  store_name: string | null;
  store_description: string | null;
  store_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Category {
  id: number;
  workspace_id: number;
  name: string;
  description: string;
  instructions: string;
  gmail_label_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Thread {
  id: number;
  workspace_id: number;
  gmail_thread_id: string;
  subject: string;
  snippet: string;
  thread_summary: string | null;
  category_id: number | null;
  status: ThreadStatus;
  auto_replied: boolean;
  created_at: Date;
  updated_at: Date;
}

export type ThreadStatus = "new" | "in_review" | "replied" | "ignored" | "closed";

export interface Message {
  id: number;
  thread_id: number;
  gmail_message_id: string;
  from_address: string;
  body_plain: string;
  body_html: string;
  received_at: Date;
  direction: MessageDirection;
  message_id_header: string | null;
}

export type MessageDirection = "inbound" | "outbound";

export interface Draft {
  id: number;
  thread_id: number;
  body: string;
  status: DraftStatus;
  was_auto_sent: boolean;
  was_edited: boolean;
  final_body: string | null;
  sent_at: Date | null;
  ai_model_used: string | null;
  created_at: Date;
  updated_at: Date;
}

export type DraftStatus = "pending" | "approved" | "rejected" | "sent";

export interface Setting {
  id: number;
  workspace_id: number;
  key: string;
  value: string;
  updated_at: Date;
}

export interface OAuthToken {
  id: number;
  workspace_id: number;
  email: string;
  expiry: Date;
  last_history_id: string | null;
  created_at: Date;
  updated_at: Date;
  access_token_encrypted: Uint8Array | null;
  refresh_token_encrypted: Uint8Array | null;
}

export interface SheetColumn {
  id: number;
  workspace_id: number;
  column_letter: string;
  header_name: string;
  created_at: Date;
  updated_at: Date;
}

export interface SheetUpdate {
  id: number;
  workspace_id: number;
  thread_id: number | null;
  column_letter: string;
  match_column: string;
  match_value: string;
  new_value: string;
  applied: boolean;
  error: string | null;
  created_at: Date;
}

export interface Interaction {
  id: number;
  workspace_id: number;
  thread_id: number | null;
  category_id: number | null;
  draft_id: number | null;
  outcome: "approved" | "rejected" | "edited";
  original_body: string | null;
  final_body: string | null;
  was_edited: boolean;
  created_at: Date;
}

// ─── API request/response payloads ────────────────────────────────────────────

export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface ThreadListItem extends Thread {
  category_name: string | null;
  draft_count: number;
}

export interface ThreadDetail extends Thread {
  messages: Message[];
  drafts: Draft[];
  category: Category | null;
}

export interface CreateCategoryPayload {
  name: string;
  description: string;
  instructions: string;
}

export type UpdateCategoryPayload = Partial<CreateCategoryPayload>;

export interface UpdateDraftStatusPayload {
  status: DraftStatus;
  body?: string; // allow submitting edited body on approval
}

export interface UpdateSettingPayload {
  value: string;
}

export interface CreateWorkspacePayload {
  name: string;
  gmail_address?: string;
  sheet_id?: string;
  sheet_name?: string;
  store_name?: string;
  store_description?: string;
  store_url?: string;
}

export type UpdateWorkspacePayload = Partial<CreateWorkspacePayload>;

export interface GmailPushNotificationPayload {
  message: {
    data: string;       // base64-encoded JSON
    messageId: string;
    publishTime: string;
  };
  subscription: string;
}

export interface GmailPushData {
  emailAddress: string;
  historyId: string;
}

// ─── AI service types ─────────────────────────────────────────────────────────

export interface CategorisationResult {
  categoryId: number | null;
  confidence: number;
  reasoning: string;
}

// ─── Gmail API types ─────────────────────────────────────────────────────────

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: GmailMessagePart;
  internalDate: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType: string;
  headers: Array<{ name: string; value: string }>;
  body: { size: number; data?: string };
  parts?: GmailMessagePart[];
}

export interface GmailThread {
  id: string;
  historyId: string;
  messages: GmailMessage[];
}

// ─── Sheet Rules ──────────────────────────────────────────────────────────────

/** A single column update definition stored in sheet_rules.updates JSONB. */
export interface RuleUpdateDefinition {
  column: string;         // sheet column header name
  mode: "fixed" | "ai";
  value?: string;         // used when mode = "fixed"
  instruction?: string;   // used when mode = "ai"
}

export interface SheetRule {
  id: number;
  workspace_id: number;
  name: string;
  description: string;
  is_active: boolean;
  category_ids: number[] | null;
  match_instruction: string;
  match_column: string;
  updates: RuleUpdateDefinition[];
  auto_apply: boolean;
  created_at: Date;
  updated_at: Date;
}

export type SheetRuleExecutionStatus = "pending" | "approved" | "rejected" | "applied" | "failed";

export interface SheetRuleExecution {
  id: number;
  workspace_id: number;
  rule_id: number;
  thread_id: number | null;
  row_number: number | null;
  match_value: string | null;
  proposed_updates: Record<string, string>;
  status: SheetRuleExecutionStatus;
  applied_at: Date | null;
  error: string | null;
  created_at: Date;
}

export interface CreateSheetRulePayload {
  name: string;
  description: string;
  is_active: boolean;
  category_ids: number[] | null;
  match_instruction: string;
  match_column: string;
  updates: RuleUpdateDefinition[];
  auto_apply: boolean;
}

export type UpdateSheetRulePayload = Partial<CreateSheetRulePayload>;

// ─── App error type ───────────────────────────────────────────────────────────

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// ─── API error response envelope ─────────────────────────────────────────────

export interface ErrorResponse {
  error: {
    message: string;
    detail?: string;
    status: number;
  };
}
