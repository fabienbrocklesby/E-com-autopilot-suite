/**
 * Threads route - /threads
 * Handles listing threads, fetching a single thread, and updating thread status.
 * All SQL lives in this file's query helpers keeping routes thin.
 */
import { Hono } from "hono";
import { execute, query, queryOne } from "../db/client.ts";
import {
  AppError,
  Thread,
  ThreadDetail,
  ThreadListItem,
} from "../types/index.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { categoriseAndDraft } from "../services/categorisation.ts";
import { sendHumanReply } from "../services/human-reply.ts";
import { fetchThreadListItem } from "../db/queries.ts";
import { publish } from "../services/event-bus.ts";

export const threadsRouter = new Hono();

// All thread routes require auth.
threadsRouter.use("*", authMiddleware);

// GET /threads - list threads with pagination and optional status filter
threadsRouter.get("/", async (c) => {
  const limitParam = c.req.query("limit");
  const offsetParam = c.req.query("offset");
  const statusFilter = c.req.query("status");
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");

  const limit = Math.min(parseInt(limitParam ?? "50"), 200);
  const offset = parseInt(offsetParam ?? "0");

  // Filter threads by the active Google account so switching accounts shows the right inbox.
  const activeToken = await queryOne<{ email: string }>(
    "SELECT email FROM oauth_tokens WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1",
    [workspaceId],
  );
  if (!activeToken) {
    return c.json({ threads: [], limit, offset });
  }

  const rows = await query<ThreadListItem>(
    `SELECT
       t.*,
       cat.name AS category_name,
       COUNT(d.id)::int AS draft_count,
       EXISTS(
         SELECT 1 FROM playbook_runs r
         JOIN playbooks rp ON rp.id = r.playbook_id
         WHERE r.thread_id = t.id
           AND r.workspace_id = t.workspace_id
           AND r.status = 'waiting_for_human'
           AND EXISTS (
             SELECT 1
             FROM jsonb_array_elements(COALESCE(r.steps_snapshot, rp.steps)) AS step
             WHERE step->>'id' = r.current_step_id
           )
       ) AS has_pending_action,
       lr.id AS latest_run_id,
       lr.status AS latest_run_status,
       lr.current_step_id AS latest_run_step,
       lp.name AS latest_run_playbook_name,
       lr.updated_at AS latest_run_updated_at,
       (SELECT COUNT(*)::int FROM jsonb_array_elements(lp.steps)) AS latest_run_total_steps,
       (SELECT COUNT(*)::int FROM playbook_step_executions pse WHERE pse.run_id = lr.id AND pse.status = 'success') AS latest_run_completed_steps
     FROM threads t
     LEFT JOIN categories cat ON cat.id = t.category_id
     LEFT JOIN drafts d ON d.thread_id = t.id
     LEFT JOIN LATERAL (
       SELECT pr.* FROM playbook_runs pr
       WHERE pr.thread_id = t.id
       ORDER BY pr.created_at DESC LIMIT 1
     ) lr ON true
     LEFT JOIN playbooks lp ON lp.id = lr.playbook_id
     WHERE t.workspace_id = $1
       AND t.account_email = $2
       AND ($3::text IS NULL OR t.status = $3)
     GROUP BY t.id, cat.name, lr.id, lr.status, lr.current_step_id, lp.name, lr.updated_at, lp.steps
     ORDER BY t.created_at DESC
     LIMIT $4 OFFSET $5`,
    [workspaceId, activeToken.email, statusFilter ?? null, limit, offset],
  );

  return c.json({ threads: rows, limit, offset });
});

// GET /threads/:id - fetch a single thread with messages and drafts
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

// PATCH /threads/:id/status - update a thread's status
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
  if (updated) {
    const threadItem = await fetchThreadListItem(id, updated.workspace_id);
    if (threadItem) {
      publish({
        type: "thread_updated",
        workspaceId: updated.workspace_id,
        thread: threadItem as unknown as Record<string, unknown>,
      });
    }
  }
  return c.json({ thread: updated });
});

// POST /threads/:id/categorise - trigger AI categorisation + draft generation
threadsRouter.post("/:id/categorise", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid thread ID");

  const result = await categoriseAndDraft(id);
  return c.json(result);
});

// GET /threads/:id/drafts - retired. Playbook pending-sends and manual replies
// are the single draft model now (docs/PLAYBOOK_ENGINE.md). The drafts table
// is kept for historical data; do not drop it until a prod check confirms no
// pending rows remain: SELECT count(*) FROM drafts WHERE status = 'pending';
threadsRouter.get("/:id/drafts", (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid thread ID");
  throw new AppError(
    410,
    "Legacy draft endpoint retired. Use playbook runs (/playbooks/runs) and manual replies (/threads/:id/manual-reply) instead.",
  );
});

// PATCH /threads/:id/drafts/:draftId - retired, see GET /threads/:id/drafts above.
threadsRouter.patch("/:id/drafts/:draftId", (c) => {
  const threadId = parseInt(c.req.param("id"));
  const draftId = parseInt(c.req.param("draftId"));
  if (isNaN(threadId) || isNaN(draftId)) throw new AppError(400, "Invalid ID");
  throw new AppError(
    410,
    "Legacy draft endpoint retired. Use playbook runs (/playbooks/runs) and manual replies (/threads/:id/manual-reply) instead.",
  );
});

// POST /threads/:id/manual-reply - operator sends a manual reply to the customer
threadsRouter.post("/:id/manual-reply", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid thread ID");

  const body = await c.req.json<{ body?: string; workspace_id?: number }>();
  if (!body.body || typeof body.body !== "string" || body.body.trim().length === 0) {
    throw new AppError(422, "body is required and must be non-empty");
  }
  if (body.body.trim().length > 10_000) {
    throw new AppError(422, "body must not exceed 10,000 characters");
  }

  const workspaceId = body.workspace_id ?? 1;
  const result = await sendHumanReply(workspaceId, id, body.body.trim());
  return c.json(result);
});
