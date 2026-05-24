/**
 * Background workers for Gmail watch renewal and fallback polling.
 *
 * - Watch renewal: Gmail Pub/Sub watches expire after 7 days. This worker
 *   checks every 6 hours and renews any watch that expires within 24 hours.
 *
 * - Fallback poller: If a Pub/Sub message is missed, this polls Gmail's
 *   history.list every 5 minutes to catch up on any new messages.
 */
import { query, queryOne } from "../db/client.ts";
import { OAuthToken } from "../types/index.ts";
import { processNewMessages, setupGmailWatch } from "./gmail.ts";
import { isGoogleReconnectRequiredError } from "./google-auth.ts";

const WATCH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FALLBACK_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const WATCH_RENEW_THRESHOLD_MS = 24 * 60 * 60 * 1000; // renew if < 24 hours left
const RECONNECT_REQUIRED_BACKOFF_MS = 15 * 60 * 1000;

const reconnectRequiredBackoff = new Map<
  string,
  { retryAfterMs: number; tokenUpdatedAtMs: number }
>();

/**
 * Start a periodic loop that renews Gmail watches before they expire.
 * Returns a cleanup handle (call clearInterval to stop).
 */
export function startWatchRenewalLoop(): ReturnType<typeof setInterval> {
  // Run immediately on start, then on every interval.
  renewExpiringWatches().catch((err) =>
    console.error("[watch] Initial renewal check failed:", err)
  );

  return setInterval(() => {
    renewExpiringWatches().catch((err) => console.error("[watch] Renewal check failed:", err));
  }, WATCH_CHECK_INTERVAL_MS);
}

/**
 * Start a periodic loop that polls Gmail history for any missed messages.
 * Returns a cleanup handle.
 */
export function startFallbackPoller(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    pollAllAccounts().catch((err) => console.error("[watch] Fallback poll failed:", err));
  }, FALLBACK_POLL_INTERVAL_MS);
}

async function renewExpiringWatches(): Promise<void> {
  const tokens = await query<Pick<OAuthToken, "email" | "workspace_id" | "updated_at">>(
    "SELECT email, workspace_id, updated_at FROM oauth_tokens",
  );

  for (const token of tokens) {
    if (shouldSkipReconnectRequiredAccount(token.email, token.updated_at)) continue;
    try {
      // Read the gmail_watch_expiry stored in settings for this workspace.
      const row = await queryOne<{ value: string }>(
        "SELECT value FROM settings WHERE workspace_id = $1 AND key = 'gmail_watch_expiry'",
        [token.workspace_id ?? 1],
      );

      if (row?.value) {
        const expiryMs = parseInt(row.value, 10); // Gmail returns ms-since-epoch string
        const msRemaining = expiryMs - Date.now();
        if (msRemaining > WATCH_RENEW_THRESHOLD_MS) {
          // Watch is healthy - skip
          continue;
        }
      }
      // No expiry recorded or expiry is within the threshold - renew.
      console.log(`[watch] Renewing Gmail watch for ${token.email}`);
      await setupGmailWatch(token.email);
    } catch (err) {
      if (rememberReconnectRequired(token.email, token.updated_at, err, "watch renewal")) {
        continue;
      }
      console.error(`[watch] Failed to renew watch for ${token.email}:`, err);
    }
  }
}

async function pollAllAccounts(): Promise<void> {
  const tokens = await query<Pick<OAuthToken, "email" | "last_history_id" | "updated_at">>(
    "SELECT email, last_history_id, updated_at FROM oauth_tokens WHERE last_history_id IS NOT NULL",
  );

  for (const token of tokens) {
    if (!token.last_history_id) continue;
    if (shouldSkipReconnectRequiredAccount(token.email, token.updated_at)) continue;
    try {
      await processNewMessages(token.email, token.last_history_id);
    } catch (err) {
      if (rememberReconnectRequired(token.email, token.updated_at, err, "fallback polling")) {
        continue;
      }
      console.error(`[watch] Fallback poll failed for ${token.email}:`, err);
    }
  }
}

function tokenUpdatedAtMs(updatedAt: Date | string): number {
  return new Date(updatedAt).getTime();
}

function shouldSkipReconnectRequiredAccount(email: string, updatedAt: Date | string): boolean {
  const backoff = reconnectRequiredBackoff.get(email);
  if (!backoff) return false;

  if (tokenUpdatedAtMs(updatedAt) > backoff.tokenUpdatedAtMs) {
    reconnectRequiredBackoff.delete(email);
    return false;
  }

  if (Date.now() < backoff.retryAfterMs) return true;

  reconnectRequiredBackoff.delete(email);
  return false;
}

function rememberReconnectRequired(
  email: string,
  updatedAt: Date | string,
  err: unknown,
  operation: string,
): boolean {
  if (!isGoogleReconnectRequiredError(err)) return false;

  reconnectRequiredBackoff.set(email, {
    retryAfterMs: Date.now() + RECONNECT_REQUIRED_BACKOFF_MS,
    tokenUpdatedAtMs: tokenUpdatedAtMs(updatedAt),
  });
  console.error(
    `[watch] Google account ${email} needs reconnection; ${operation} paused for 15 minutes.`,
  );
  return true;
}
