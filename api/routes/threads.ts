/**
 * Threads route — /threads
 * Handles listing threads, fetching a single thread, and updating thread status.
 * All SQL lives in this file's query helpers keeping routes thin.
 */
import { Hono } from "hono";
import { query, queryOne, execute } from "../db/client.ts";
import { AppError, Thread, ThreadListItem, ThreadDetail, Draft, Message, UpdateDraftStatusPayload } from "../types/index.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { categoriseAndDraft } from "../services/categorisation.ts";
import { sendReply } from "../services/gmail.ts";
import { recordInteraction } from "../services/learning.ts";

export const threadsRouter = new Hono();

// All thread routes require auth.
threadsRouter.use("*", authMiddleware);

// GET /threads — list threads with pagination and optional status filter
threadsRouter.get("/", async (c) => {
  const limitParam = c.req.query("limit");
  const offsetParam = c.req.query("offset");
  const statusFilter = c.req.query("status");
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");

  const limit = Math.min(parseInt(limitParam ?? "50"), 200);
  const offset = parseInt(offsetParam ?? "0");

  const rows = await query<ThreadListItem>(
    `SELECT
       t.*,
       cat.name AS category_name,
       COUNT(d.id)::int AS draft_count
     FROM threads t
     LEFT JOIN categories cat ON cat.id = t.category_id
     LEFT JOIN drafts d ON d.thread_id = t.id
     WHERE t.workspace_id = $1
       AND ($2::text IS NULL OR t.status = $2)
     GROUP BY t.id, cat.name
     ORDER BY t.created_at DESC
     LIMIT $3 OFFSET $4`,
    [workspaceId, statusFilter ?? null, limit, offset],
  );

  return c.json({ threads: rows, limit, offset });
});

// GET /threads/:id — fetch a single thread with messages and drafts
threadsRouter.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid thread ID");

  const thread = await queryOne<Thread>(
    "SELECT * FROM threads WHERE id = $1",
    [id],
  );
  if (!thread) throw new AppError(404, "Thread not found");

  const [messages, drafts, category] = await Promise.all([
    query("SELECT * FROM messages WHERE thread_id = $1 ORDER BY received_at ASC", [id]),
    query("SELECT * FROM drafts WHERE thread_id = $1 ORDER BY created_at DESC", [id]),
    thread.category_id
      ? queryOne("SELECT * FROM categories WHERE id = $1", [thread.category_id])
      : Promise.resolve(null),
  ]);

  const detail: ThreadDetail = { ...thread, messages, drafts, category } as ThreadDetail;
  return c.json({ thread: detail });
});

// PATCH /threads/:id/status — update a thread's status
threadsRouter.patch("/:id/status", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid thread ID");

  const body = await c.req.json<{ status: string }>();
  const validStatuses = ["new", "in_review", "replied", "ignored", "closed"];
  if (!validStatuses.includes(body.status)) {
    throw new AppError(422, `status must be one of: ${validStatuses.join(", ")}`);
  }

  const affected = await execute(
    "UPDATE threads SET status = $1 WHERE id = $2",
    [body.status, id],
  );
  if (affected === 0) throw new AppError(404, "Thread not found");

  const updated = await queryOne<Thread>("SELECT * FROM threads WHERE id = $1", [id]);
  return c.json({ thread: updated });
});

// POST /threads/:id/categorise — trigger AI categorisation + draft generation
threadsRouter.post("/:id/categorise", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid thread ID");

  const result = await categoriseAndDraft(id);
  return c.json(result);
});

// GET /threads/:id/drafts — list drafts for a thread
threadsRouter.get("/:id/drafts", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid thread ID");

  const drafts = await query(
    "SELECT * FROM drafts WHERE thread_id = $1 ORDER BY created_at DESC",
    [id],
  );
  return c.json({ drafts });
});

// PATCH /threads/:id/drafts/:draftId — approve / reject / mark sent
threadsRouter.patch("/:id/drafts/:draftId", async (c) => {
  const threadId = parseInt(c.req.param("id"));
  const draftId = parseInt(c.req.param("draftId"));
  if (isNaN(threadId) || isNaN(draftId)) throw new AppError(400, "Invalid ID");

  const body = await c.req.json<UpdateDraftStatusPayload>();
  const validStatuses = ["pending", "approved", "rejected", "sent"];
  if (!validStatuses.includes(body.status)) {
    throw new AppError(422, `status must be one of: ${validStatuses.join(", ")}`);
  }

  // Load draft and thread upfront for tracking.
  const [existingDraft, thread] = await Promise.all([
    queryOne<Draft>("SELECT * FROM drafts WHERE id = $1 AND thread_id = $2", [draftId, threadId]),
    queryOne<Thread>("SELECT * FROM threads WHERE id = $1", [threadId]),
  ]);
  if (!existingDraft) throw new AppError(404, "Draft not found");
  if (!thread) throw new AppError(404, "Thread not found");

  // When a draft is approved, send the reply via Gmail immediately.
  if (body.status === "approved") {
    const lastInbound = await queryOne<Message>(
      "SELECT * FROM messages WHERE thread_id = $1 AND direction = 'inbound' ORDER BY received_at DESC LIMIT 1",
      [threadId],
    );
    if (!lastInbound) throw new AppError(422, "No inbound message to reply to");

    const tokenRow = await queryOne<{ email: string }>(
      "SELECT email FROM oauth_tokens WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1",
      [thread.workspace_id],
    );
    if (!tokenRow) throw new AppError(500, "No connected Gmail account");

    // Allow submitting an edited body alongside the approval.
    const submittedBody = typeof body.body === "string" ? body.body.trim() : null;
    const finalBody = submittedBody || existingDraft.body;
    const wasEdited = submittedBody !== null && submittedBody !== existingDraft.body.trim();
    const sentAt = new Date().toISOString();

    await sendReply(
      tokenRow.email,
      thread.gmail_thread_id,
      thread.subject,
      lastInbound.from_address,
      finalBody,
      lastInbound.message_id_header,
      thread.id,
    );

    // Mark draft as sent with full tracking metadata.
    await execute(
      `UPDATE drafts
       SET status = 'sent', was_edited = $1, final_body = $2, sent_at = $3
       WHERE id = $4`,
      [wasEdited, finalBody, sentAt, draftId],
    );
    await execute("UPDATE threads SET status = 'replied' WHERE id = $1", [threadId]);

    // Record the interaction for learning.
    await recordInteraction({
      workspaceId: thread.workspace_id,
      threadId: thread.id,
      categoryId: thread.category_id,
      draftId: existingDraft.id,
      outcome: wasEdited ? "edited" : "approved",
      originalBody: existingDraft.body,
      finalBody: finalBody,
    }).catch((err) => console.error("[threads] Failed to record interaction:", err));
  } else if (body.status === "rejected") {
    await execute(
      "UPDATE drafts SET status = 'rejected' WHERE id = $1",
      [draftId],
    );

    // Record rejection for learning.
    await recordInteraction({
      workspaceId: thread.workspace_id,
      threadId: thread.id,
      categoryId: thread.category_id,
      draftId: existingDraft.id,
      outcome: "rejected",
      originalBody: existingDraft.body,
      finalBody: null,
    }).catch((err) => console.error("[threads] Failed to record interaction:", err));
  } else {
    await execute(
      "UPDATE drafts SET status = $1 WHERE id = $2 AND thread_id = $3",
      [body.status, draftId, threadId],
    );
  }

  const draft = await queryOne("SELECT * FROM drafts WHERE id = $1", [draftId]);
  return c.json({ draft });
});
