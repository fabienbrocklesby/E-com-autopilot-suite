/**
 * Gmail service.
 * Raw HTTP calls to the Gmail REST API v1.
 * Reference: https://developers.google.com/gmail/api/reference/rest
 */
import { queryOne, execute, query } from "../db/client.ts";
import { AppError, GmailMessage, GmailThread, Category } from "../types/index.ts";
import { categoriseAndDraft } from "./categorisation.ts";
import { getGoogleAccessToken } from "./google-auth.ts";
import { resumeRun } from "./playbook/executor.ts";
import type { PlaybookRun } from "./playbook/types.ts";

const GMAIL_BASE = "https://www.googleapis.com/gmail/v1/users";

// ─── Gmail API helpers ────────────────────────────────────────────────────────

async function gmailGet<T>(email: string, path: string): Promise<T> {
  const { token: accessToken } = await getGoogleAccessToken(email);
  const res = await fetch(`${GMAIL_BASE}/${encodeURIComponent(email)}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(res.status as 400 | 401 | 403 | 404 | 500, `Gmail API error on ${path}`, detail);
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
    throw new AppError(res.status as 400 | 401 | 403 | 404 | 500, `Gmail API error on POST ${path}`, detail);
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
    throw new AppError(res.status as 400 | 401 | 403 | 404 | 500, `Gmail API error on PATCH ${path}`, detail);
  }
  return res.json() as Promise<T>;
}

// ─── Public service methods ───────────────────────────────────────────────────

/**
 * Fetch a Gmail thread by its thread ID.
 */
export async function fetchGmailThread(
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
    // No new messages — update the stored historyId and return.
    await execute(
      "UPDATE oauth_tokens SET last_history_id = $1 WHERE email = $2",
      [historyId, email],
    );
    return;
  }

  for (const entry of history.history) {
    for (const added of entry.messagesAdded ?? []) {
      const msg = added.message;
      await ingestMessage(email, msg.id, msg.threadId, workspaceId);
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

  const gmailThread = await fetchGmailThread(email, gmailThreadId);
  const gmailMsg = gmailThread.messages.find((m) => m.id === gmailMessageId);
  if (!gmailMsg) return;

  const subject = headerValue(gmailMsg, "Subject") ?? "(no subject)";
  const from = headerValue(gmailMsg, "From") ?? "";
  const messageIdHeader = headerValue(gmailMsg, "Message-Id") ?? headerValue(gmailMsg, "Message-ID") ?? null;
  const receivedAt = new Date(parseInt(gmailMsg.internalDate)).toISOString();
  const { plain, html } = extractBody(gmailMsg);

  // Determine message direction. Gmail's SENT label is the authoritative signal —
  // compare against the connected account email as a secondary check.
  const hasSentLabel = gmailMsg.labelIds?.includes("SENT") ?? false;
  const fromNormalised = from.toLowerCase();
  const accountNormalised = email.toLowerCase();
  // A message is outbound if it carries SENT or was sent from the connected account.
  const direction: "inbound" | "outbound" =
    hasSentLabel || fromNormalised.includes(accountNormalised) ? "outbound" : "inbound";

  // Build a short summary by truncating plain text to 1000 chars.
  const threadSummary = plain.replace(/\s+/g, " ").trim().slice(0, 1000);

  // Upsert the thread record, now with workspace_id and thread_summary.
  const threadRow = await queryOne<{ id: number }>(
    `INSERT INTO threads (workspace_id, gmail_thread_id, subject, snippet, thread_summary)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (gmail_thread_id) DO UPDATE
       SET snippet = EXCLUDED.snippet,
           thread_summary = EXCLUDED.thread_summary
     RETURNING id`,
    [workspaceId, gmailThreadId, subject, gmailMsg.snippet, threadSummary],
  );

  if (!threadRow) return;

  // Insert the message, storing the RFC 2822 Message-ID for reply threading.
  await execute(
    `INSERT INTO messages
       (thread_id, gmail_message_id, from_address, body_plain, body_html, received_at, direction, message_id_header)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (gmail_message_id) DO NOTHING`,
    [threadRow.id, gmailMessageId, from, plain, html, receivedAt, direction, messageIdHeader],
  );

  // Only run categorisation for inbound messages. Outbound messages (sent by this
  // app or by the user) must not trigger another draft or auto-reply loop.
  if (direction === "outbound") {
    console.log(`[gmail] Skipping categorisation for outbound message ${gmailMessageId}`);
    return;
  }

  // Phase 2: Check if this thread has an active playbook run waiting for customer reply.
  const activeRun = await queryOne<PlaybookRun>(
    `SELECT * FROM playbook_runs
     WHERE thread_id = $1 AND status = 'waiting_for_customer'
     ORDER BY created_at DESC LIMIT 1`,
    [threadRow.id],
  );

  if (activeRun) {
    console.log(`[gmail] Thread ${threadRow.id} has active playbook run ${activeRun.id} — resuming`);
    try {
      await resumeRun(activeRun.id);
    } catch (err) {
      console.error(`[gmail] Failed to resume playbook run ${activeRun.id}:`, err);
    }
    return;
  }

  // Run the categorisation pipeline (which may route to a playbook for new threads).
  await categoriseAndDraft(threadRow.id);
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
): Promise<void> {
  // Build an RFC 2822 reply message.
  // If we have the original email's Message-ID, use it for proper threading.
  // The threadId in the API request also helps Gmail place the sent message.
  const headers = [
    `From: ${email}`,
    `To: ${replyToAddress}`,
    `Subject: Re: ${subject.replace(/^Re:\s*/i, "")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
  ];

  if (inReplyToMessageId) {
    // Ensure it is wrapped in angle brackets (RFC 2822 requires this).
    const mid = inReplyToMessageId.startsWith("<")
      ? inReplyToMessageId
      : `<${inReplyToMessageId}>`;
    headers.push(`In-Reply-To: ${mid}`);
    headers.push(`References: ${mid}`);
  }

  const rawMessage = [...headers, "", body].join("\r\n");

  // base64url encode (no padding, URL-safe chars).
  const encoded = btoa(unescape(encodeURIComponent(rawMessage)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  // Pass threadId only when we also have valid reply headers — otherwise Gmail
  // will return 404 if the headers don't reference a message in that thread.
  const payload: Record<string, string> = { raw: encoded };
  if (inReplyToMessageId) {
    payload.threadId = gmailThreadId;
  }

  await gmailPost(email, "/messages/send", payload);

  console.log(`[gmail] Reply sent for thread ${gmailThreadId}`);
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

  console.log(`[gmail] Watch set up for ${email}. Expires: ${result.expiration}`);
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
 * Synchronise Gmail labels with workspace categories — bidirectional.
 *
 * Pass 1 (categories → Gmail): For each category without a gmail_label_id,
 *   create the Gmail label. For categories whose stored label no longer exists,
 *   re-create it.
 *
 * Pass 2 (Gmail → categories): For each user-created Gmail label that has no
 *   matching category, create the category so the AI can use it.
 *
 * Returns the total number of labels/categories created or linked.
 */
export async function syncLabels(
  email: string,
  workspaceId: number,
): Promise<number> {
  // Gmail system label prefixes/names to skip when importing.
  const SYSTEM_LABEL_PREFIXES = ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH",
    "STARRED", "IMPORTANT", "UNREAD", "CATEGORY_", "CHAT"];

  // Fetch existing Gmail labels.
  const labelList = await gmailGet<{ labels: Array<{ id: string; name: string; type?: string }> }>(
    email,
    "/labels",
  );
  const existingLabels = labelList.labels ?? [];
  const labelByName = new Map(existingLabels.map((l) => [l.name.toLowerCase(), l.id]));
  const labelById   = new Map(existingLabels.map((l) => [l.id, l.name]));

  const categories = await query<Category>(
    "SELECT * FROM categories WHERE workspace_id = $1",
    [workspaceId],
  );

  // Build a set of names already covered by a category (lowercase).
  const coveredNames = new Set(categories.map((c) => c.name.toLowerCase()));

  let synced = 0;

  // ── Pass 1: categories → Gmail ─────────────────────────────────────────────
  for (const cat of categories) {
    // Already linked — check if the category was renamed and propagate to Gmail.
    if (cat.gmail_label_id && labelById.has(cat.gmail_label_id)) {
      const gmailName = labelById.get(cat.gmail_label_id);
      if (gmailName?.toLowerCase() !== cat.name.toLowerCase()) {
        await gmailPatch<{ id: string; name: string }>(
          email,
          `/labels/${cat.gmail_label_id}`,
          { name: cat.name },
        );
        synced++;
        console.log(`[gmail] Renamed Gmail label "${gmailName}" → "${cat.name}"`);
      }
      continue;
    }

    // A label with the same name already exists in Gmail — link it.
    const existingId = labelByName.get(cat.name.toLowerCase());
    if (existingId) {
      await execute(
        "UPDATE categories SET gmail_label_id = $1 WHERE id = $2",
        [existingId, cat.id],
      );
      synced++;
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
  }

  // ── Pass 2: Gmail → categories ────────────────────────────────────────────
  // Dashboard is the source of truth. Gmail-side label creates/renames are
  // surfaced as untracked labels (logged) rather than auto-imported — the
  // client must create or rename categories in the dashboard.
  for (const label of existingLabels) {
    // Skip system labels.
    const isSystem = label.type === "system" ||
      SYSTEM_LABEL_PREFIXES.some((p) => label.name.toUpperCase().startsWith(p));
    if (isSystem) continue;

    // Skip if a category already covers this label name.
    if (coveredNames.has(label.name.toLowerCase())) continue;

    // Skip if a category is already linked to this label id.
    const linkedCategory = categories.find((c) => c.gmail_label_id === label.id);
    if (linkedCategory) continue;

    // Untracked label — log it for visibility but do not auto-create a category.
    console.log(`[gmail] Untracked Gmail label "${label.name}" (${label.id}) — create a category in the dashboard to link it`);
  }

  console.log(`[gmail] Synced ${synced} labels for workspace ${workspaceId}`);
  return synced;
}
