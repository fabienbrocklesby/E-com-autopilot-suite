/**
 * Webhooks route — /webhooks
 * Receives Gmail Pub/Sub push notifications and processes new emails.
 *
 * Reference: https://developers.google.com/gmail/api/guides/push
 *
 * Google delivers a POST to this endpoint with a base64-encoded JSON payload
 * inside the Pub/Sub message envelope. The handler decodes the data, fetches
 * new messages from Gmail, and runs the categorisation pipeline.
 */
import { Hono } from "hono";
import { AppError, GmailPushNotificationPayload, GmailPushData } from "../types/index.ts";
import { processNewMessages } from "../services/gmail.ts";

export const webhooksRouter = new Hono();

// POST /webhooks/gmail — receives Gmail Pub/Sub push notifications
webhooksRouter.post("/gmail", async (c) => {
  const body = await c.req.json<GmailPushNotificationPayload>();

  if (!body?.message?.data) {
    throw new AppError(400, "Invalid Pub/Sub message envelope");
  }

  // Decode the base64url-encoded data field
  const decoded = atob(body.message.data.replace(/-/g, "+").replace(/_/g, "/"));
  let pushData: GmailPushData;

  try {
    pushData = JSON.parse(decoded) as GmailPushData;
  } catch {
    throw new AppError(400, "Could not parse Pub/Sub message data");
  }

  if (!pushData.emailAddress || !pushData.historyId) {
    throw new AppError(400, "Push data missing emailAddress or historyId");
  }

  // Process asynchronously — return 204 quickly so Google does not retry.
  // Errors during processing are logged but must not cause a non-2xx response
  // here (that would trigger Pub/Sub retries for already-processed messages).
  processNewMessages(pushData.emailAddress, pushData.historyId).catch((err) => {
    console.error("[webhook/gmail] Processing error:", err);
  });

  return c.body(null, 204);
});
