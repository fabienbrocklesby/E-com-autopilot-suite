// Shared TypeScript types for the email automation dashboard API.

// ─── Database row types ───────────────────────────────────────────────────────

export interface Category {
  id: number;
  name: string;
  description: string;
  instructions: string;
  allow_auto_reply: boolean;
  confidence_threshold: number;
  writing_style: string;
  created_at: Date;
  updated_at: Date;
}

export interface Thread {
  id: number;
  gmail_thread_id: string;
  subject: string;
  snippet: string;
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
}

export type MessageDirection = "inbound" | "outbound";

export interface Draft {
  id: number;
  thread_id: number;
  body: string;
  status: DraftStatus;
  created_at: Date;
  updated_at: Date;
}

export type DraftStatus = "pending" | "approved" | "rejected" | "sent";

export interface Setting {
  id: number;
  key: string;
  value: string;
  updated_at: Date;
}

export interface OAuthToken {
  id: number;
  email: string;
  access_token: string;
  refresh_token: string;
  expiry: Date;
  created_at: Date;
  updated_at: Date;
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
  allow_auto_reply: boolean;
  confidence_threshold: number;
  writing_style: string;
}

export type UpdateCategoryPayload = Partial<CreateCategoryPayload>;

export interface UpdateDraftStatusPayload {
  status: DraftStatus;
}

export interface UpdateSettingPayload {
  value: string;
}

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

export interface DraftReplyResult {
  body: string;
}

export interface ThreadWithMessages {
  thread: Thread;
  messages: Message[];
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
