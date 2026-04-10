/**
 * Gmail service.
 * Raw HTTP calls to the Gmail REST API v1.
 * Reference: https://developers.google.com/gmail/api/reference/rest
 */
import { queryOne, execute } from "../db/client.ts";
import { AppError, GmailMessage, GmailThread, OAuthToken } from "../types/index.ts";
import { categoriseAndDraft } from "./categorisation.ts";

const GMAIL_BASE = "https://www.googleapis.com/gmail/v1/users";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ─── Token management ─────────────────────────────────────────────────────────

/**
 * Return a valid access token for the given email, refreshing if it is within
 * 60 seconds of expiry.
 */
async function getValidAccessToken(email: string): Promise<string> {
  const tokenRow = await queryOne<OAuthToken>(
    "SELECT * FROM oauth_tokens WHERE email = $1",
    [email],
  );
  if (!tokenRow) {
    throw new AppError(401, `No OAuth token stored for ${email}`);
  }

  const expiryMs = new Date(tokenRow.expiry).getTime();
  const bufferMs = 60 * 1000;

  if (Date.now() < expiryMs - bufferMs) {
    return tokenRow.access_token;
  }

  // Token is expired or about to expire — refresh it.
  return refreshAccessToken(email, tokenRow.refresh_token);
}

/** Exchange a refresh token for a new access token and persist it. */
async function refreshAccessToken(email: string, refreshToken: string): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new AppError(500, "Google OAuth credentials are not configured");
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new AppError(502, "Failed to refresh Google access token", detail);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  const expiry = new Date(Date.now() + data.expires_in * 1000).toISOString();

  await execute(
    "UPDATE oauth_tokens SET access_token = $1, expiry = $2 WHERE email = $3",
    [data.access_token, expiry, email],
  );

  return data.access_token;
}

// ─── Gmail API helpers ────────────────────────────────────────────────────────

async function gmailGet<T>(email: string, path: string): Promise<T> {
  const accessToken = await getValidAccessToken(email);
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
  const accessToken = await getValidAccessToken(email);
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

  // Get the last known historyId from settings to avoid re-processing.
  const lastHistoryRow = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'gmail_last_history_id'",
  );
  const startHistoryId = lastHistoryRow?.value ?? historyId;

  const history = await gmailGet<{
    history?: Array<{
      messagesAdded?: Array<{ message: { id: string; threadId: string } }>;
    }>;
    historyId: string;
  }>(email, `/history?startHistoryId=${startHistoryId}&historyTypes=messageAdded`);

  if (!history.history?.length) {
    // No new messages — update the stored historyId and return.
    await execute(
      `INSERT INTO settings (key, value)
       VALUES ('gmail_last_history_id', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [historyId],
    );
    return;
  }

  for (const entry of history.history) {
    for (const added of entry.messagesAdded ?? []) {
      const msg = added.message;
      await ingestMessage(email, msg.id, msg.threadId);
    }
  }

  // Persist the latest historyId.
  await execute(
    `INSERT INTO settings (key, value)
     VALUES ('gmail_last_history_id', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [historyId],
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
  const receivedAt = new Date(parseInt(gmailMsg.internalDate)).toISOString();
  const { plain, html } = extractBody(gmailMsg);

  // Upsert the thread record.
  const threadRow = await queryOne<{ id: number }>(
    `INSERT INTO threads (gmail_thread_id, subject, snippet)
     VALUES ($1, $2, $3)
     ON CONFLICT (gmail_thread_id) DO UPDATE SET snippet = EXCLUDED.snippet
     RETURNING id`,
    [gmailThreadId, subject, gmailMsg.snippet],
  );

  if (!threadRow) return;

  // Insert the message.
  await execute(
    `INSERT INTO messages
       (thread_id, gmail_message_id, from_address, body_plain, body_html, received_at, direction)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (gmail_message_id) DO NOTHING`,
    [threadRow.id, gmailMessageId, from, plain, html, receivedAt, "inbound"],
  );

  // Run the categorisation pipeline.
  await categoriseAndDraft(threadRow.id);
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
      plain += atob(part.body.data.replace(/-/g, "+").replace(/_/g, "/"));
    } else if (part.mimeType === "text/html" && part.body.data) {
      html += atob(part.body.data.replace(/-/g, "+").replace(/_/g, "/"));
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
): Promise<void> {
  // Build a minimal RFC 2822 message.
  const rawMessage = [
    `From: ${email}`,
    `To: ${replyToAddress}`,
    `Subject: Re: ${subject.replace(/^Re:\s*/i, "")}`,
    `In-Reply-To: <${gmailThreadId}>`,
    `References: <${gmailThreadId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");

  // base64url encode (no padding, URL-safe chars).
  const encoded = btoa(unescape(encodeURIComponent(rawMessage)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmailPost(email, "/messages/send", {
    raw: encoded,
    threadId: gmailThreadId,
  });

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

  await execute(
    `INSERT INTO settings (key, value)
     VALUES ('gmail_watch_expiry', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [result.expiration],
  );

  console.log(`[gmail] Watch set up for ${email}. Expires: ${result.expiration}`);
}
