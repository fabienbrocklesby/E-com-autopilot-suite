/**
 * Sends an email that was held pending human approval.
 * Used by the /runs/:id/approve endpoint when a send_reply or ask_customer
 * step was paused due to require_approval or reply_mode === 'draft_only'.
 */
import { query, queryOne } from "../../db/client.ts";
import { sendReply } from "../gmail.ts";
import type { PlaybookRun } from "./types.ts";

interface ThreadRow {
  gmail_thread_id: string;
  subject: string;
  workspace_id: number;
}

interface MessageRow {
  direction: string;
  from_address: string;
  message_id_header: string | null;
}

interface OAuthRow {
  email: string;
}

/**
 * Sends the pending_send message for a run that was held for approval.
 * Resolves the thread/email context from the run's workspace and thread.
 */
export async function sendApprovedReply(run: PlaybookRun, body: string): Promise<void> {
  const thread = await queryOne<ThreadRow>(
    "SELECT gmail_thread_id, subject, workspace_id FROM threads WHERE id = $1",
    [run.thread_id],
  );
  if (!thread) throw new Error(`Thread ${run.thread_id} not found for run ${run.id}`);

  const messages = await query<MessageRow>(
    "SELECT direction, from_address, message_id_header FROM messages WHERE thread_id = $1 ORDER BY received_at ASC",
    [run.thread_id],
  );

  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound") ?? null;
  if (!lastInbound?.from_address) {
    throw new Error(`No inbound message found for thread ${run.thread_id} - cannot determine reply address`);
  }

  const tokenRow = await queryOne<OAuthRow>(
    "SELECT email FROM oauth_tokens WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1",
    [thread.workspace_id],
  );
  if (!tokenRow) throw new Error(`No OAuth token found for workspace ${thread.workspace_id}`);

  await sendReply(
    tokenRow.email,
    thread.gmail_thread_id,
    thread.subject,
    lastInbound.from_address,
    body,
    lastInbound.message_id_header,
    run.thread_id,
    thread.workspace_id,
  );
}
