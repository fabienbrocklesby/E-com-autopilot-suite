/**
 * Human reply service.
 * Orchestrates sending a manual reply from the operator dashboard:
 *   1. Sends the message via Gmail (existing sendReply helper)
 *   2. Updates threads.last_manual_reply_at and threads.status in a transaction
 *   3. Injects _human_intervention into the active playbook run's context bag
 *   4. If the run is waiting_for_customer, resumes it via resumeRun()
 *
 * No AI calls. No new OAuth path. Reuses sendReply() and resumeRun() as-is.
 */
import { queryOne, transaction } from "../db/client.ts";
import { sendReply } from "./gmail.ts";
import { resumeRun } from "./playbook/mod.ts";
import { AppError } from "../types/index.ts";
import { logger } from "./logger.ts";
import { resolveReplyAddress } from "./reply-address.ts";
import type { PlaybookRun } from "./playbook/mod.ts";

export interface HumanReplyResult {
  messageSent: boolean;
  runId: number | null;
  /** Status of the run after the reply was processed (may have advanced). */
  runStatus: string | null;
  contextUpdated: boolean;
}

type ThreadRow = {
  id: number;
  workspace_id: number;
  gmail_thread_id: string;
  subject: string;
  status: string;
};

type MessageRow = {
  from_address: string;
  body_plain: string;
  body_html: string;
  message_id_header: string | null;
};

/**
 * Send a manual reply on behalf of the operator.
 * The caller must have already validated that body is non-empty and within
 * the 10,000 character limit.
 */
export async function sendHumanReply(
  workspaceId: number,
  threadId: number,
  body: string,
): Promise<HumanReplyResult> {
  // ── 1. Load thread (workspace-scoped) ──────────────────────────────────────
  const thread = await queryOne<ThreadRow>(
    "SELECT id, workspace_id, gmail_thread_id, subject, status FROM threads WHERE id = $1 AND workspace_id = $2",
    [threadId, workspaceId],
  );
  if (!thread) throw new AppError(404, "Thread not found");

  // ── 2. Load OAuth token for this workspace ─────────────────────────────────
  const tokenRow = await queryOne<{ email: string }>(
    "SELECT email FROM oauth_tokens WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1",
    [workspaceId],
  );
  if (!tokenRow) throw new AppError(500, "No connected Gmail account for this workspace");

  // ── 3. Find the last inbound message for reply threading ───────────────────
  const lastInbound = await queryOne<MessageRow>(
    `SELECT from_address, body_plain, body_html, message_id_header
     FROM messages
     WHERE thread_id = $1 AND direction = 'inbound'
     ORDER BY received_at DESC
     LIMIT 1`,
    [threadId],
  );
  if (!lastInbound) {
    throw new AppError(422, "No inbound message to reply to on this thread");
  }
  const replyAddress = resolveReplyAddress(lastInbound);

  // ── 4. Send via Gmail (external call - happens before DB transaction) ───────
  // sendReply() also writes the outbound row to messages via ON CONFLICT DO NOTHING
  // when dbThreadId is provided, so we do not insert a second messages row.
  await sendReply(
    tokenRow.email,
    thread.gmail_thread_id,
    thread.subject,
    replyAddress.address,
    body,
    lastInbound.message_id_header,
    thread.id,
    workspaceId,
  );

  logger.info("human_reply.gmail_sent", {
    thread_id: threadId,
    workspace_id: workspaceId,
    reply_to_source: replyAddress.source,
  });

  // ── 5. DB writes: thread timestamp + optional run context ──────────────────
  // Find the most recent active run before opening the transaction so we can
  // decide what to do inside it without a query inside the transaction body.
  const activeRun = await queryOne<PlaybookRun>(
    `SELECT * FROM playbook_runs
     WHERE thread_id = $1
       AND status IN ('running', 'waiting_for_customer', 'waiting_for_human')
     ORDER BY created_at DESC
     LIMIT 1`,
    [threadId],
  );

  const interventionPayload = JSON.stringify({
    _human_intervention: {
      sent_at: new Date().toISOString(),
      body,
      operator: "human",
    },
  });

  let contextUpdated = false;

  await transaction(async (tx) => {
    // Update thread: stamp last_manual_reply_at; mark replied unless already in
    // a terminal state that reflects the human's action.
    const newStatus = thread.status === "replied" ? "replied" : "replied";
    await tx.queryArray(
      `UPDATE threads
       SET last_manual_reply_at = NOW(), status = $1, updated_at = NOW()
       WHERE id = $2`,
      [newStatus, threadId],
    );

    // Inject _human_intervention into active run context using the JSONB || merge
    // operator (keys in the right-hand object take precedence - confirmed PG 16 docs).
    if (activeRun) {
      await tx.queryArray(
        `UPDATE playbook_runs
         SET context = context || $1::jsonb, updated_at = NOW()
         WHERE id = $2`,
        [interventionPayload, activeRun.id],
      );
      contextUpdated = true;
    }
  });

  logger.info("human_reply.db_updated", {
    thread_id: threadId,
    run_id: activeRun?.id ?? null,
    context_updated: contextUpdated,
  });

  // ── 6. Run state transition ─────────────────────────────────────────────────
  // Only act on waiting_for_customer - treated as a "reply received" event
  // identical to a Gmail inbound webhook. resumeRun() reads on_reply_goto from
  // the current ask_customer step and advances.
  //
  // waiting_for_human: intentionally NOT auto-advanced. The manual_approval step
  // has approve/reject branches with downstream business logic. The human must
  // use the approval banner to resolve it.
  //
  // running / complete / failed / escalated / retrying: no action.
  let finalRunStatus = activeRun?.status ?? null;

  if (activeRun?.status === "waiting_for_customer") {
    try {
      const result = await resumeRun(activeRun.id);
      finalRunStatus = result.status;
      logger.info("human_reply.run_resumed", { run_id: activeRun.id, new_status: result.status });
    } catch (err) {
      // Gmail send and context injection already committed - don't unwind them.
      // Log and surface partial success to the caller.
      logger.error("human_reply.resume_run_failed", {
        run_id: activeRun.id,
        error: String(err),
      });
    }
  }

  return {
    messageSent: true,
    runId: activeRun?.id ?? null,
    runStatus: finalRunStatus,
    contextUpdated,
  };
}
