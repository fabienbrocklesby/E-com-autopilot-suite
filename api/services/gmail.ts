/**
 * Gmail service.
 * Raw HTTP calls to the Gmail REST API v1.
 * Reference: https://developers.google.com/gmail/api/reference/rest
 */
import { execute, query, queryOne, transaction } from "../db/client.ts";
import { AppError, Category, GmailMessage, GmailThread, Message, Setting } from "../types/index.ts";
import { categoriseAndDraft, categoriseFromGmailLabels } from "./categorisation.ts";
import { getGoogleAccessToken } from "./google-auth.ts";
import { advanceRun, resumeRun } from "./playbook/executor.ts";
import type { PlaybookRun, RunStatus } from "./playbook/types.ts";
import { logger } from "./logger.ts";
import { rateLimitedCall } from "./rate_limit.ts";
import { publish } from "./event-bus.ts";
import { fetchThreadListItem } from "../db/queries.ts";
import { getReadableEmailText } from "./email-text.ts";

const GMAIL_BASE = "https://www.googleapis.com/gmail/v1/users";

// ─── Gmail API helpers ────────────────────────────────────────────────────────

async function gmailGet<T>(email: string, path: string): Promise<T> {
  const { token: accessToken } = await getGoogleAccessToken(email);
  const res = await fetch(`${GMAIL_BASE}/${encodeURIComponent(email)}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(
      res.status as 400 | 401 | 403 | 404 | 500,
      `Gmail API error on ${path}`,
      detail,
    );
  }
  return res.json() as Promise<T>;
}

async function gmailPost<T>(email: string, path: string, body: unknown): Promise<T> {
  const { token: accessToken } = await getGoogleAccessToken(email);
  const res = await fetch(`${GMAIL_BASE}/${encodeURIComponent(email)}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(
      res.status as 400 | 401 | 403 | 404 | 500,
      `Gmail API error on POST ${path}`,
      detail,
    );
  }
  return res.json() as Promise<T>;
}

async function gmailPatch<T>(email: string, path: string, body: unknown): Promise<T> {
  const { token: accessToken } = await getGoogleAccessToken(email);
  const res = await fetch(`${GMAIL_BASE}/${encodeURIComponent(email)}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(
      res.status as 400 | 401 | 403 | 404 | 500,
      `Gmail API error on PATCH ${path}`,
      detail,
    );
  }
  return res.json() as Promise<T>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Retry an async operation up to `maxAttempts` times when it throws an
 * AppError with statusCode 404. Waits `baseDelayMs * attempt` between tries.
 */
async function retryOn404<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
  baseDelayMs = 1500,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404 && attempt < maxAttempts) {
        const delay = baseDelayMs * attempt;
        logger.warn("gmail.retry_404", { attempt, max_attempts: maxAttempts, delay_ms: delay });
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  // unreachable, but satisfies TypeScript
  throw new Error("retryOn404: exhausted attempts");
}

// ─── Public service methods ───────────────────────────────────────────────────

/**
 * Fetch a Gmail thread by its thread ID.
 */
export function fetchGmailThread(
  email: string,
  gmailThreadId: string,
): Promise<GmailThread> {
  return gmailGet<GmailThread>(email, `/threads/${gmailThreadId}?format=full`);
}

/**
 * Fetch message history since a given historyId and process any new messages.
 * Called from the Pub/Sub webhook handler.
 */
export async function processNewMessages(
  email: string,
  historyId: string,
): Promise<void> {
  // Resolve workspace for this connected email.
  const tokenRow = await queryOne<{ workspace_id: number; last_history_id: string | null }>(
    "SELECT workspace_id, last_history_id FROM oauth_tokens WHERE email = $1",
    [email],
  );
  const workspaceId = tokenRow?.workspace_id ?? 1;
  const startHistoryId = tokenRow?.last_history_id ?? historyId;

  const history = await gmailGet<{
    history?: Array<{
      messagesAdded?: Array<{ message: { id: string; threadId: string } }>;
    }>;
    historyId: string;
  }>(email, `/history?startHistoryId=${startHistoryId}&historyTypes=messageAdded`);

  if (!history.history?.length) {
    // No new messages - update the stored historyId and return.
    await execute(
      "UPDATE oauth_tokens SET last_history_id = $1 WHERE email = $2",
      [historyId, email],
    );
    return;
  }

  for (const entry of history.history) {
    for (const added of entry.messagesAdded ?? []) {
      const msg = added.message;
      try {
        await rateLimitedCall(
          workspaceId,
          "gmail",
          () => ingestMessage(email, msg.id, msg.threadId, workspaceId),
        );
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 404) {
          logger.warn("gmail.thread_not_found", {
            gmail_thread_id: msg.threadId,
            gmail_message_id: msg.id,
          });
          continue;
        }
        // DLQ: capture failed ingestion for retry
        logger.error("gmail.ingest_failed", {
          workspace_id: workspaceId,
          gmail_message_id: msg.id,
          gmail_thread_id: msg.threadId,
          error: String(err),
        });
        await execute(
          `INSERT INTO failed_ingestions (workspace_id, gmail_message_id, gmail_thread_id, error, payload)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workspace_id, gmail_message_id) WHERE NOT resolved
           DO UPDATE SET attempt_count = failed_ingestions.attempt_count + 1,
                         error = EXCLUDED.error, last_attempt_at = NOW()`,
          [workspaceId, msg.id, msg.threadId, String(err), JSON.stringify({ msg })],
        ).catch((dlqErr) => {
          logger.error("gmail.dlq_insert_failed", { error: String(dlqErr) });
        });
        continue;
      }
    }
  }

  // Persist the latest historyId.
  await execute(
    "UPDATE oauth_tokens SET last_history_id = $1 WHERE email = $2",
    [historyId, email],
  );
}

/**
 * Fetch a single Gmail message, upsert the thread and message records, and
 * trigger the categorisation pipeline.
 */
async function ingestMessage(
  email: string,
  gmailMessageId: string,
  gmailThreadId: string,
  workspaceId: number,
): Promise<void> {
  // Avoid duplicate processing.
  const existing = await queryOne(
    "SELECT id FROM messages WHERE gmail_message_id = $1",
    [gmailMessageId],
  );
  if (existing) return;

  const gmailThread = await retryOn404(() => fetchGmailThread(email, gmailThreadId));
  const gmailMsg = gmailThread.messages.find((m) => m.id === gmailMessageId);
  if (!gmailMsg) return;

  const parsedMessages = gmailThread.messages.map((message) =>
    parseGmailMessageForIngest(message, email)
  );
  const currentMessage = parsedMessages.find((message) =>
    message.gmailMessageId === gmailMessageId
  );
  if (!currentMessage) return;

  // Build a short summary from the latest webhook-triggering message.
  const threadSummary = currentMessage.plain.replace(/\s+/g, " ").trim().slice(0, 1000);

  // Upsert the thread record, now with workspace_id, thread_summary, and account_email.
  // account_email ties the thread to the specific Google account that ingested it so that
  // switching accounts hides threads from the old inbox.
  const threadRow = await queryOne<{ id: number; is_new_row: boolean }>(
    `INSERT INTO threads (workspace_id, gmail_thread_id, subject, snippet, thread_summary, account_email)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (gmail_thread_id) DO UPDATE
       SET snippet = EXCLUDED.snippet,
           thread_summary = EXCLUDED.thread_summary,
           account_email = EXCLUDED.account_email
     RETURNING id, (xmax = 0) AS is_new_row`,
    [workspaceId, gmailThreadId, currentMessage.subject, gmailMsg.snippet, threadSummary, email],
  );

  if (!threadRow) return;

  const threadListItem = await fetchThreadListItem(threadRow.id, workspaceId);
  if (threadListItem) {
    publish({
      type: threadRow.is_new_row ? "thread_created" : "thread_updated",
      workspaceId,
      thread: threadListItem as unknown as Record<string, unknown>,
    });
  }

  // Gmail gives us the whole conversation here. Store every missing message before
  // categorisation so AI/playbooks can see context from threads that existed pre-launch.
  let currentInsertedMessageId: number | null = null;
  for (const parsedMessage of parsedMessages) {
    const insertedMsg = await queryOne<Message>(
      `INSERT INTO messages
         (thread_id, gmail_message_id, from_address, body_plain, body_html, received_at, direction, message_id_header)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (gmail_message_id) DO NOTHING
       RETURNING *`,
      [
        threadRow.id,
        parsedMessage.gmailMessageId,
        parsedMessage.from,
        parsedMessage.plain,
        parsedMessage.html,
        parsedMessage.receivedAt,
        parsedMessage.direction,
        parsedMessage.messageIdHeader,
      ],
    );

    if (insertedMsg) {
      publish({
        type: "message_created",
        workspaceId,
        threadId: threadRow.id,
        message: insertedMsg,
      });
      if (parsedMessage.gmailMessageId === currentMessage.gmailMessageId) {
        currentInsertedMessageId = insertedMsg.id;
      }
    }
  }

  // Only run categorisation for inbound messages. Outbound messages (sent by this
  // app or by the user) must not trigger another draft or auto-reply loop.
  if (currentMessage.direction === "outbound") {
    logger.debug("gmail.skip_outbound", { gmail_message_id: gmailMessageId });
    return;
  }

  // A thread with any non-terminal run is never recategorised (design doc 3.2) - a new
  // inbound message must never destroy an active run. Recategorisation below only ever
  // runs when there is no active run for this thread.
  const activeRun = await queryOne<PlaybookRun>(
    `SELECT * FROM playbook_runs
     WHERE thread_id = $1
       AND status IN ('running', 'waiting_for_customer', 'waiting_for_human', 'waiting_to_send', 'retrying')
     ORDER BY created_at DESC LIMIT 1`,
    [threadRow.id],
  );

  switch (resolveInboundRunAction(activeRun?.status ?? null)) {
    case "resume": {
      logger.info("gmail.resume_playbook_run", { thread_id: threadRow.id, run_id: activeRun!.id });
      try {
        await resumeRun(activeRun!.id);
      } catch (err) {
        logger.error("gmail.resume_run_failed", { run_id: activeRun!.id, error: String(err) });
      }
      return;
    }
    case "attach_to_waiting_human": {
      await attachMessageToWaitingRun(
        activeRun!,
        currentInsertedMessageId,
        currentMessage.receivedAt,
      );
      return;
    }
    case "requeue_send": {
      await requeuePendingSend(activeRun!);
      return;
    }
    case "store_only": {
      logger.info("gmail.inbound_during_active_run", {
        thread_id: threadRow.id,
        run_id: activeRun!.id,
        run_status: activeRun!.status,
      });
      return;
    }
    case "none":
      break; // no active run - fall through to recategorisation
  }

  const gmailLabelsAuthoritative = await isGmailLabelsAuthoritative(workspaceId);
  if (gmailLabelsAuthoritative) {
    logger.info("gmail.labels_authoritative_categorisation", {
      thread_id: threadRow.id,
      gmail_label_ids: currentMessage.labelIds,
    });
    await categoriseFromGmailLabels(threadRow.id, currentMessage.labelIds);
    return;
  }

  // Run the AI categorisation pipeline (which may route to a playbook for new threads).
  await categoriseAndDraft(threadRow.id);
}

export type InboundRunAction =
  | "resume"
  | "attach_to_waiting_human"
  | "requeue_send"
  | "store_only"
  | "none";

/**
 * Maps a thread's active playbook run status to what an inbound customer
 * message should do to it. The rule behind every branch (design doc 3.2): a
 * new message never destroys an active run. Only "none" (no active run, or a
 * terminal one) allows the thread to fall through to recategorisation.
 */
export function resolveInboundRunAction(runStatus: RunStatus | null): InboundRunAction {
  switch (runStatus) {
    case "waiting_for_customer":
      return "resume";
    case "waiting_for_human":
      return "attach_to_waiting_human";
    case "waiting_to_send":
      return "requeue_send";
    case "running":
    case "retrying":
      return "store_only";
    default:
      // null (no active run), complete, failed, escalated, cancelled.
      return "none";
  }
}

/**
 * Appends a newly-arrived message marker to a waiting_for_human run's context
 * so the approval UI can show "customer replied since this draft was written"
 * and offer regeneration (Task 8). Pure so the append logic is unit-testable
 * without a database round trip.
 */
export function appendMessageToWaitingRun(
  context: Record<string, unknown>,
  entry: { message_id: number | null; received_at: string },
): Record<string, unknown> {
  const existing = Array.isArray(context._messages_since_draft)
    ? context._messages_since_draft
    : [];
  return { ...context, _messages_since_draft: [...existing, entry] };
}

async function attachMessageToWaitingRun(
  run: PlaybookRun,
  messageId: number | null,
  receivedAt: string,
): Promise<void> {
  const currentContext = typeof run.context === "string"
    ? JSON.parse(run.context)
    : { ...run.context };
  const updatedContext = appendMessageToWaitingRun(currentContext, {
    message_id: messageId,
    received_at: receivedAt,
  });
  const updatedRun = await queryOne<PlaybookRun & { playbook_name: string }>(
    `UPDATE playbook_runs pr SET context = $1
     FROM playbooks p WHERE pr.playbook_id = p.id AND pr.id = $2
     RETURNING pr.*, p.name AS playbook_name`,
    [JSON.stringify(updatedContext), run.id],
  );
  if (updatedRun) {
    publish({
      type: "run_updated",
      workspaceId: run.workspace_id,
      threadId: run.thread_id,
      run: updatedRun,
    });
  }
  logger.info("gmail.inbound_during_waiting_for_human", {
    run_id: run.id,
    thread_id: run.thread_id,
  });
}

async function requeuePendingSend(run: PlaybookRun): Promise<void> {
  // current_step_id already points at the send_reply step - a paused
  // waiting_to_send run never advances its cursor (see executor.ts's pause
  // case). Clearing send_after and setting the run back to running re-enters
  // that same step, which reloads the full transcript (including this new
  // message) and re-queues the delayed send.
  await execute(
    "UPDATE playbook_runs SET status = 'running', send_after = NULL WHERE id = $1",
    [run.id],
  );
  logger.info("gmail.inbound_during_waiting_to_send", { run_id: run.id, thread_id: run.thread_id });
  try {
    await advanceRun(run.id);
  } catch (err) {
    logger.error("gmail.requeue_send_failed", { run_id: run.id, error: String(err) });
  }
}

interface ParsedGmailMessage {
  gmailMessageId: string;
  subject: string;
  from: string;
  plain: string;
  html: string;
  receivedAt: string;
  direction: "inbound" | "outbound";
  messageIdHeader: string | null;
  labelIds: string[];
}

function parseGmailMessageForIngest(
  gmailMsg: GmailMessage,
  accountEmail: string,
): ParsedGmailMessage {
  const from = headerValue(gmailMsg, "From") ?? "";
  const { plain, html } = extractBody(gmailMsg);
  const readablePlain = getReadableEmailText({ body_plain: plain, body_html: html });
  const hasSentLabel = gmailMsg.labelIds?.includes("SENT") ?? false;
  const fromNormalised = from.toLowerCase();
  const accountNormalised = accountEmail.toLowerCase();

  return {
    gmailMessageId: gmailMsg.id,
    subject: headerValue(gmailMsg, "Subject") ?? "(no subject)",
    from,
    plain: readablePlain,
    html,
    receivedAt: new Date(parseInt(gmailMsg.internalDate)).toISOString(),
    direction: hasSentLabel || fromNormalised.includes(accountNormalised) ? "outbound" : "inbound",
    messageIdHeader: headerValue(gmailMsg, "Message-Id") ??
      headerValue(gmailMsg, "Message-ID") ?? null,
    labelIds: gmailMsg.labelIds ?? [],
  };
}

async function isGmailLabelsAuthoritative(workspaceId: number): Promise<boolean> {
  const setting = await queryOne<Setting>(
    "SELECT * FROM settings WHERE workspace_id = $1 AND key = 'gmail_labels_authoritative'",
    [workspaceId],
  );
  return setting?.value === "true";
}

/**
 * Decode a base64url string from Gmail as a proper UTF-8 string.
 * atob() returns a Latin-1 binary string which mangles multibyte chars (e.g. smart quotes).
 */
function decodeBase64Utf8(base64url: string): string {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

/** Extract a header value from a Gmail message. */
function headerValue(msg: GmailMessage, name: string): string | undefined {
  return msg.payload.headers.find(
    (h) => h.name.toLowerCase() === name.toLowerCase(),
  )?.value;
}

/** Recursively extract plain text and HTML body from a Gmail message part. */
function extractBody(msg: GmailMessage): { plain: string; html: string } {
  let plain = "";
  let html = "";

  function walk(part: GmailMessage["payload"]): void {
    if (part.mimeType === "text/plain" && part.body.data) {
      plain += decodeBase64Utf8(part.body.data);
    } else if (part.mimeType === "text/html" && part.body.data) {
      html += decodeBase64Utf8(part.body.data);
    }
    for (const child of part.parts ?? []) {
      walk(child);
    }
  }

  walk(msg.payload);
  return { plain, html };
}

function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<html><body><p>${escaped.replace(/\n/g, "<br>")}</p></body></html>`;
}

/**
 * Send a reply to a Gmail thread on behalf of the authenticated user.
 * Constructs a minimal RFC 2822 message, base64url-encodes it, and sends
 * it via the Gmail messages.send API with the threadId attached so it
 * appears as a reply in the same thread.
 */
export async function sendReply(
  email: string,
  gmailThreadId: string,
  subject: string,
  replyToAddress: string,
  body: string,
  inReplyToMessageId?: string | null,
  /** DB thread.id - when provided the sent message is written immediately so
   *  it appears in the dashboard without waiting for the Pub/Sub webhook. */
  dbThreadId?: number,
  workspaceId = 1,
): Promise<void> {
  // Build an RFC 2822 reply message.
  // If we have the original email's Message-ID, use it for proper threading.
  // The threadId in the API request also helps Gmail place the sent message.
  const headers = [
    `From: ${email}`,
    `To: ${replyToAddress}`,
    `Subject: Re: ${subject.replace(/^Re:\s*/i, "")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
  ];

  if (inReplyToMessageId) {
    // Ensure it is wrapped in angle brackets (RFC 2822 requires this).
    const mid = inReplyToMessageId.startsWith("<") ? inReplyToMessageId : `<${inReplyToMessageId}>`;
    headers.push(`In-Reply-To: ${mid}`);
    headers.push(`References: ${mid}`);
  }

  const rawMessage = [...headers, "", textToHtml(body)].join("\r\n");

  // base64url encode (no padding, URL-safe chars).
  const encoded = btoa(unescape(encodeURIComponent(rawMessage)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  // Pass threadId only when we also have valid reply headers - otherwise Gmail
  // will return 404 if the headers don't reference a message in that thread.
  const payload: Record<string, string> = { raw: encoded };
  if (inReplyToMessageId) {
    payload.threadId = gmailThreadId;
  }

  const sent = await rateLimitedCall(
    workspaceId,
    "gmail",
    () => gmailPost<{ id: string }>(email, "/messages/send", payload),
  );

  logger.info("gmail.reply_sent", { gmail_thread_id: gmailThreadId, message_id: sent.id });

  // Immediately record the outbound message so it appears in the dashboard
  // without waiting for the Pub/Sub webhook (which can take minutes).
  // The webhook will hit ON CONFLICT DO NOTHING when it eventually fires.
  if (dbThreadId) {
    const sentMsg = await queryOne<Message>(
      `INSERT INTO messages
         (thread_id, gmail_message_id, from_address, body_plain, body_html, received_at, direction, message_id_header)
       VALUES ($1, $2, $3, $4, $5, $6, 'outbound', NULL)
       ON CONFLICT (gmail_message_id) DO NOTHING
       RETURNING *`,
      [dbThreadId, sent.id, email, body, "", new Date().toISOString()],
    );
    if (sentMsg) {
      publish({ type: "message_created", workspaceId, threadId: dbThreadId, message: sentMsg });
    }
  }
}

/**
 * Set up a Gmail Pub/Sub watch on the authenticated user's inbox.
 * Should be called once after OAuth and then refreshed every 7 days.
 */
export async function setupGmailWatch(email: string): Promise<void> {
  const topicName = Deno.env.get("PUBSUB_TOPIC");
  if (!topicName) throw new AppError(500, "PUBSUB_TOPIC is not configured");

  const result = await gmailPost<{ historyId: string; expiration: string }>(
    email,
    "/watch",
    {
      topicName,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    },
  );

  // Resolve workspace_id for this account so we can upsert with the composite key.
  const tokenRow = await queryOne<{ workspace_id: number }>(
    "SELECT workspace_id FROM oauth_tokens WHERE email = $1",
    [email],
  );
  const workspaceId = tokenRow?.workspace_id ?? 1;

  await execute(
    `INSERT INTO settings (workspace_id, key, value)
     VALUES ($1, 'gmail_watch_expiry', $2)
     ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [workspaceId, result.expiration],
  );

  logger.info("gmail.watch_setup", { email, expiration: result.expiration });
}

// ─── Label management ─────────────────────────────────────────────────────────

/**
 * Apply a Gmail label to a thread via the modify endpoint.
 */
export async function applyLabel(
  email: string,
  gmailThreadId: string,
  labelId: string,
): Promise<void> {
  await gmailPost(email, `/threads/${gmailThreadId}/modify`, {
    addLabelIds: [labelId],
  });
}

/**
 * Synchronise Gmail labels with workspace categories.
 *
 * Pass 1 (categories → Gmail): For each category without a gmail_label_id,
 *   create the Gmail label. For categories whose stored label no longer exists,
 *   re-create it. Skipped when Gmail labels are authoritative.
 *
 * Pass 2 (Gmail → categories): For each user-created Gmail label that has no
 *   matching category, create the category so routing can use it.
 *
 * Returns the total number of labels/categories created or linked.
 */
export async function syncLabels(
  email: string,
  workspaceId: number,
): Promise<number> {
  type GmailLabel = { id: string; name: string; type?: string };

  // Gmail system label prefixes/names to skip when importing.
  const SYSTEM_LABEL_PREFIXES = [
    "INBOX",
    "SENT",
    "DRAFT",
    "SPAM",
    "TRASH",
    "STARRED",
    "IMPORTANT",
    "UNREAD",
    "CATEGORY_",
    "CHAT",
  ];

  // Fetch existing Gmail labels.
  const labelList = await gmailGet<{ labels: GmailLabel[] }>(
    email,
    "/labels",
  );
  const existingLabels = labelList.labels ?? [];
  const labelByName = new Map(existingLabels.map((l) => [l.name.toLowerCase(), l.id]));
  const labelById = new Map(existingLabels.map((l) => [l.id, l.name]));

  const categories = await query<Category>(
    "SELECT * FROM categories WHERE workspace_id = $1",
    [workspaceId],
  );
  const gmailLabelsAuthoritative = await isGmailLabelsAuthoritative(workspaceId);

  // Build a set of names already covered by a category (lowercase).
  const coveredNames = new Set(categories.map((c) => c.name.toLowerCase()));
  const categoryByName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));
  const coveredLabelIds = new Set(
    categories
      .map((c) => c.gmail_label_id)
      .filter((id): id is string => Boolean(id)),
  );

  let synced = 0;

  // ── Pass 1: categories → Gmail ─────────────────────────────────────────────
  if (!gmailLabelsAuthoritative) {
    for (const cat of categories) {
      // Already linked - check if the category was renamed and propagate to Gmail.
      if (cat.gmail_label_id && labelById.has(cat.gmail_label_id)) {
        const gmailName = labelById.get(cat.gmail_label_id);
        if (gmailName?.toLowerCase() !== cat.name.toLowerCase()) {
          await gmailPatch<{ id: string; name: string }>(
            email,
            `/labels/${cat.gmail_label_id}`,
            { name: cat.name },
          );
          synced++;
          logger.info("gmail.label_renamed", {
            workspace_id: workspaceId,
            old_name: gmailName,
            new_name: cat.name,
          });
        }
        coveredLabelIds.add(cat.gmail_label_id);
        continue;
      }

      // A label with the same name already exists in Gmail - link it.
      const existingId = labelByName.get(cat.name.toLowerCase());
      if (existingId) {
        await execute(
          "UPDATE categories SET gmail_label_id = $1 WHERE id = $2",
          [existingId, cat.id],
        );
        synced++;
        coveredLabelIds.add(existingId);
        continue;
      }

      // Create a new Gmail label for this category.
      const created = await gmailPost<{ id: string; name: string }>(
        email,
        "/labels",
        {
          name: cat.name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        },
      );
      await execute(
        "UPDATE categories SET gmail_label_id = $1 WHERE id = $2",
        [created.id, cat.id],
      );
      synced++;
      coveredLabelIds.add(created.id);
    }
  } else {
    logger.info("gmail.label_sync_gmail_authoritative", { workspace_id: workspaceId });
  }

  // ── Pass 2: Gmail → categories ────────────────────────────────────────────
  // Gmail labels created outside the dashboard become blank categories, matching
  // the normal category creation flow with an inactive playbook ready to edit.
  for (const label of existingLabels) {
    // Skip system labels.
    const isSystem = label.type === "system" ||
      SYSTEM_LABEL_PREFIXES.some((p) => label.name.toUpperCase().startsWith(p));
    if (isSystem) continue;

    // Skip if a category is already linked to this label id.
    if (coveredLabelIds.has(label.id)) continue;

    const sameNameCategory = categoryByName.get(label.name.toLowerCase());
    if (sameNameCategory) {
      await execute(
        "UPDATE categories SET gmail_label_id = $1 WHERE id = $2",
        [label.id, sameNameCategory.id],
      );
      coveredLabelIds.add(label.id);
      synced++;
      logger.info("gmail.label_linked", {
        workspace_id: workspaceId,
        category_id: sameNameCategory.id,
        label_name: label.name,
        label_id: label.id,
      });
      continue;
    }

    // Skip if a category already covers this label name.
    if (coveredNames.has(label.name.toLowerCase())) continue;

    let createdCategory: Category | null = null;
    await transaction(async (tx) => {
      const rows = await tx.queryObject<Category>({
        text:
          `INSERT INTO categories (workspace_id, name, description, instructions, gmail_label_id)
               VALUES ($1, $2, '', '', $3)
               RETURNING *`,
        args: [workspaceId, label.name, label.id],
      });
      const created = rows.rows[0];
      if (!created) throw new AppError(500, "Failed to create category from Gmail label");
      createdCategory = created;

      await tx.queryObject({
        text: `INSERT INTO playbooks (workspace_id, category_id, name, steps, version, is_active)
               VALUES ($1, $2, $3, '[]'::jsonb, 1, false)`,
        args: [workspaceId, created.id, label.name],
      });
    });

    coveredNames.add(label.name.toLowerCase());
    if (createdCategory) categoryByName.set(label.name.toLowerCase(), createdCategory);
    coveredLabelIds.add(label.id);
    synced++;
    logger.info("gmail.label_imported", {
      workspace_id: workspaceId,
      label_name: label.name,
      label_id: label.id,
    });
  }

  logger.info("gmail.labels_synced", { workspace_id: workspaceId, synced });
  return synced;
}

/**
 * Re-ingest a specific Gmail message - used by the retry worker to replay
 * failed ingestions from the dead letter queue.
 */
export async function retryIngest(
  workspaceId: number,
  gmailMessageId: string,
  gmailThreadId: string,
): Promise<void> {
  const tokenRow = await queryOne<{ email: string }>(
    "SELECT email FROM oauth_tokens WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1",
    [workspaceId],
  );
  if (!tokenRow) throw new Error(`No OAuth token for workspace ${workspaceId}`);
  await ingestMessage(tokenRow.email, gmailMessageId, gmailThreadId, workspaceId);
}
