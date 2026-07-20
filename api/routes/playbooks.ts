/**
 * Playbooks route - /playbooks
 * CRUD, parser, dry-run, run management, and manual approval.
 */
import { Hono } from "hono";
import { execute, query, queryOne } from "../db/client.ts";
import { AppError } from "../types/index.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { parsePlaybook, parsePlaybookStep } from "../services/playbook/parser.ts";
import { dryRunPlaybook } from "../services/playbook/dry-run.ts";
import { advanceRun } from "../services/playbook/mod.ts";
import { finalizeEscalation, getRunSteps } from "../services/playbook/executor.ts";
import { sendApprovedReply } from "../services/playbook/approval-sender.ts";
import { publish } from "../services/event-bus.ts";
import { fetchThreadListItem } from "../db/queries.ts";
import type {
  AskCustomerStep,
  ManualApprovalStep,
  Playbook,
  PlaybookRun,
  PlaybookStep,
  SendReplyStep,
  StepExecution,
} from "../services/playbook/types.ts";

export const playbooksRouter = new Hono();

playbooksRouter.use("*", authMiddleware);

// ─── Parser ──────────────────────────────────────────────────────────────────

// POST /playbooks/parse
playbooksRouter.post("/parse", async (c) => {
  const body = await c.req.json<{ description: string; workspace_id?: number }>();
  if (!body.description || typeof body.description !== "string") {
    throw new AppError(422, "description is required");
  }
  const workspaceId = body.workspace_id ?? 1;
  const result = await parsePlaybook(body.description.trim(), workspaceId);
  return c.json(result);
});

// POST /playbooks/parse-step
playbooksRouter.post("/parse-step", async (c) => {
  const body = await c.req.json<{
    description: string;
    previous_steps?: PlaybookStep[];
    next_steps?: PlaybookStep[];
    playbook_context?: string;
    workspace_id?: number;
  }>();
  if (!body.description || typeof body.description !== "string") {
    throw new AppError(422, "description is required");
  }
  const workspaceId = body.workspace_id ?? 1;
  const step = await parsePlaybookStep(
    body.description.trim(),
    body.previous_steps ?? [],
    body.next_steps ?? [],
    body.playbook_context ?? "",
    workspaceId,
  );
  return c.json({ step });
});

// ─── Run management (must be before /:id routes) ─────────────────────────────

// GET /playbooks/runs
playbooksRouter.get("/runs", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const threadId = c.req.query("thread_id");
  const playbookId = c.req.query("playbook_id");
  const status = c.req.query("status");

  const conditions: string[] = ["pr.workspace_id = $1"];
  const params: unknown[] = [workspaceId];

  if (threadId) {
    params.push(parseInt(threadId));
    conditions.push(`pr.thread_id = $${params.length}`);
  }
  if (playbookId) {
    params.push(parseInt(playbookId));
    conditions.push(`pr.playbook_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`pr.status = $${params.length}`);
  }

  const where = conditions.join(" AND ");

  const runs = await query<
    PlaybookRun & {
      playbook_name: string;
      step_reason: string | null;
      step_capture_input: boolean;
      step_input_prompt: string | null;
      step_reference_context: string[] | null;
      step_type: string | null;
      step_pending_send: string | null;
      step_missing: boolean;
    }
  >(
    `SELECT pr.*, p.name AS playbook_name,
      -- manual_approval: reason, capture_input, input_prompt, reference_context
      CASE WHEN pr.status = 'waiting_for_human'
        THEN (
          SELECT (step->>'reason')
          FROM jsonb_array_elements(COALESCE(pr.steps_snapshot, p.steps)) AS step
          WHERE step->>'id' = pr.current_step_id
            AND step->>'type' = 'manual_approval'
          LIMIT 1
        )
        ELSE NULL
      END AS step_reason,
      CASE WHEN pr.status = 'waiting_for_human'
        THEN (
          SELECT (step->>'capture_input')::boolean
          FROM jsonb_array_elements(COALESCE(pr.steps_snapshot, p.steps)) AS step
          WHERE step->>'id' = pr.current_step_id
            AND step->>'type' = 'manual_approval'
          LIMIT 1
        )
        ELSE false
      END AS step_capture_input,
      CASE WHEN pr.status = 'waiting_for_human'
        THEN (
          SELECT step->>'input_prompt'
          FROM jsonb_array_elements(COALESCE(pr.steps_snapshot, p.steps)) AS step
          WHERE step->>'id' = pr.current_step_id
            AND step->>'type' = 'manual_approval'
          LIMIT 1
        )
        ELSE NULL
      END AS step_input_prompt,
      CASE WHEN pr.status = 'waiting_for_human'
        THEN (
          SELECT step->'reference_context'
          FROM jsonb_array_elements(COALESCE(pr.steps_snapshot, p.steps)) AS step
          WHERE step->>'id' = pr.current_step_id
            AND step->>'type' = 'manual_approval'
          LIMIT 1
        )
        ELSE NULL
      END AS step_reference_context,
      -- current step type (for frontend to know if it's a pending send vs manual approval)
      (
        SELECT step->>'type'
        FROM jsonb_array_elements(COALESCE(pr.steps_snapshot, p.steps)) AS step
        WHERE step->>'id' = pr.current_step_id
        LIMIT 1
      ) AS step_type,
      CASE WHEN pr.current_step_id IS NULL THEN false ELSE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(pr.steps_snapshot, p.steps)) AS step
        WHERE step->>'id' = pr.current_step_id
      ) END AS step_missing,
      -- pending send body from last step execution (for send_reply/ask_customer require_approval)
      CASE WHEN pr.status = 'waiting_for_human'
        THEN (
          SELECT pse.output->>'pending_send'
          FROM playbook_step_executions pse
          WHERE pse.run_id = pr.id
            AND pse.step_id = pr.current_step_id
            AND pse.output->>'action' = 'pending_approval'
          ORDER BY pse.created_at DESC
          LIMIT 1
        )
        ELSE NULL
      END AS step_pending_send
     FROM playbook_runs pr
     JOIN playbooks p ON p.id = pr.playbook_id
     WHERE ${where}
     ORDER BY pr.created_at DESC
     LIMIT 100`,
    params,
  );

  return c.json({ runs });
});

// GET /playbooks/runs/:runId
playbooksRouter.get("/runs/:runId", async (c) => {
  const runId = parseInt(c.req.param("runId"));
  if (isNaN(runId)) throw new AppError(400, "Invalid run ID");

  const run = await queryOne<PlaybookRun & { playbook_name: string }>(
    `SELECT pr.*, p.name AS playbook_name
     FROM playbook_runs pr
     JOIN playbooks p ON p.id = pr.playbook_id
     WHERE pr.id = $1`,
    [runId],
  );
  if (!run) throw new AppError(404, "Run not found");

  const executions = await query<StepExecution>(
    "SELECT * FROM playbook_step_executions WHERE run_id = $1 ORDER BY created_at ASC",
    [runId],
  );

  return c.json({ run, executions });
});

async function cancelStaleWaitingRun(
  run: PlaybookRun,
  reason: string,
): Promise<PlaybookRun | null> {
  const currentContext = typeof run.context === "string"
    ? JSON.parse(run.context)
    : { ...run.context };
  currentContext._cancelled_reason = reason;
  currentContext._cancelled_at = new Date().toISOString();

  const updated = await queryOne<PlaybookRun>(
    `UPDATE playbook_runs
     SET status = 'cancelled', context = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [JSON.stringify(currentContext), run.id],
  );

  if (updated) {
    publish({
      type: "run_updated",
      workspaceId: run.workspace_id,
      threadId: run.thread_id,
      run: updated,
    });
    const threadItem = await fetchThreadListItem(run.thread_id, run.workspace_id);
    if (threadItem) {
      publish({
        type: "thread_updated",
        workspaceId: run.workspace_id,
        thread: threadItem as unknown as Record<string, unknown>,
      });
    }
  }

  return updated;
}

// POST /playbooks/runs/:runId/approve
playbooksRouter.post("/runs/:runId/approve", async (c) => {
  const runId = parseInt(c.req.param("runId"));
  if (isNaN(runId)) throw new AppError(400, "Invalid run ID");

  const run = await queryOne<PlaybookRun>(
    "SELECT * FROM playbook_runs WHERE id = $1",
    [runId],
  );
  if (!run) throw new AppError(404, "Run not found");
  if (run.status !== "waiting_for_human") {
    throw new AppError(409, `Run is not waiting_for_human (status: ${run.status})`);
  }

  const playbook = await queryOne<Playbook>(
    "SELECT * FROM playbooks WHERE id = $1",
    [run.playbook_id],
  );
  if (!playbook) throw new AppError(404, "Playbook not found");

  const steps = getRunSteps(run, playbook);

  const currentStep = steps.find((s) => s.id === run.current_step_id);
  if (!currentStep) {
    const updated = await cancelStaleWaitingRun(
      run,
      `Current step ${
        run.current_step_id ?? "(none)"
      } no longer exists in this run's playbook snapshot.`,
    );
    return c.json({ run: updated, result: { action: "cancelled", reason: "stale_current_step" } });
  }

  // Accept optional human input / edited reply body
  let body: { input?: string; body?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // no body - that's fine
  }

  // Handle send_reply / ask_customer steps paused for require_approval
  if (currentStep.type === "send_reply" || currentStep.type === "ask_customer") {
    const lastExec = await queryOne<StepExecution>(
      `SELECT * FROM playbook_step_executions
       WHERE run_id = $1 AND step_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [runId, currentStep.id],
    );

    const output = typeof lastExec?.output === "string"
      ? JSON.parse(lastExec.output as string)
      : (lastExec?.output as Record<string, unknown> | null);

    if (output?.action === "pending_approval" && typeof output.pending_send === "string") {
      // Use human-edited body if provided, otherwise use the AI-drafted body
      const sendBody = (typeof body.body === "string" && body.body.trim())
        ? body.body.trim()
        : output.pending_send as string;
      await sendApprovedReply(run, sendBody);

      const stepType = currentStep.type;
      const currentIndex = steps.findIndex((s) => s.id === currentStep.id);

      let nextStepId: string | null = null;
      if (stepType === "ask_customer") {
        nextStepId = (currentStep as AskCustomerStep).on_reply_goto ?? null;
      } else {
        nextStepId = currentIndex < steps.length - 1 ? steps[currentIndex + 1].id : null;
      }

      const newStatus = stepType === "ask_customer" ? "waiting_for_customer" : "running";

      if (nextStepId && newStatus === "running") {
        await execute(
          "UPDATE playbook_runs SET status = 'running', current_step_id = $1 WHERE id = $2",
          [nextStepId, runId],
        );
        publish({
          type: "run_updated",
          workspaceId: run.workspace_id,
          threadId: run.thread_id,
          run: { ...run, status: "running", current_step_id: nextStepId },
        });
        const result = await advanceRun(runId);
        const updated = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [
          runId,
        ]);
        return c.json({ run: updated, result, sent: true });
      } else if (nextStepId && newStatus === "waiting_for_customer") {
        await execute(
          "UPDATE playbook_runs SET status = 'waiting_for_customer', current_step_id = $1 WHERE id = $2",
          [nextStepId, runId],
        );
        publish({
          type: "run_updated",
          workspaceId: run.workspace_id,
          threadId: run.thread_id,
          run: { ...run, status: "waiting_for_customer", current_step_id: nextStepId },
        });
        const updated = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [
          runId,
        ]);
        return c.json({ run: updated, sent: true });
      } else {
        await execute(
          "UPDATE playbook_runs SET status = 'complete', current_step_id = NULL WHERE id = $1",
          [runId],
        );
        await execute("UPDATE threads SET status = 'closed' WHERE id = $1", [run.thread_id]);
        publish({
          type: "run_updated",
          workspaceId: run.workspace_id,
          threadId: run.thread_id,
          run: { ...run, status: "complete", current_step_id: null },
        });
        const completedThreadItem = await fetchThreadListItem(run.thread_id, run.workspace_id);
        if (completedThreadItem) {
          publish({
            type: "thread_updated",
            workspaceId: run.workspace_id,
            thread: completedThreadItem as unknown as Record<string, unknown>,
          });
        }
        const updated = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [
          runId,
        ]);
        return c.json({ run: updated, sent: true });
      }
    }
  }

  // Standard manual_approval step flow
  if (currentStep.type !== "manual_approval") {
    throw new AppError(409, "Current step is not a manual_approval step and has no pending send");
  }

  const approvalStep = currentStep as ManualApprovalStep;

  if (body.input !== undefined && body.input !== null) {
    const contextKey = approvalStep.input_context_key ?? "human_notes";
    const currentContext = typeof run.context === "string"
      ? JSON.parse(run.context)
      : { ...run.context };
    currentContext[contextKey] = body.input;
    await execute(
      "UPDATE playbook_runs SET context = $1 WHERE id = $2",
      [JSON.stringify(currentContext), runId],
    );
  }

  const nextStepId = approvalStep.on_approve;

  await execute(
    "UPDATE playbook_runs SET status = 'running', current_step_id = $1 WHERE id = $2",
    [nextStepId, runId],
  );

  publish({
    type: "run_updated",
    workspaceId: run.workspace_id,
    threadId: run.thread_id,
    run: { ...run, status: "running", current_step_id: nextStepId },
  });
  const approvedThreadItem = await fetchThreadListItem(run.thread_id, run.workspace_id);
  if (approvedThreadItem) {
    publish({
      type: "thread_updated",
      workspaceId: run.workspace_id,
      thread: approvedThreadItem as unknown as Record<string, unknown>,
    });
  }

  const result = await advanceRun(runId);
  const updated = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [runId]);
  return c.json({ run: updated, result });
});

// POST /playbooks/runs/:runId/reject
playbooksRouter.post("/runs/:runId/reject", async (c) => {
  const runId = parseInt(c.req.param("runId"));
  if (isNaN(runId)) throw new AppError(400, "Invalid run ID");

  const run = await queryOne<PlaybookRun>(
    "SELECT * FROM playbook_runs WHERE id = $1",
    [runId],
  );
  if (!run) throw new AppError(404, "Run not found");
  if (run.status !== "waiting_for_human") {
    throw new AppError(409, `Run is not waiting_for_human (status: ${run.status})`);
  }

  const playbook = await queryOne<Playbook>(
    "SELECT * FROM playbooks WHERE id = $1",
    [run.playbook_id],
  );
  if (!playbook) throw new AppError(404, "Playbook not found");

  const steps = getRunSteps(run, playbook);

  const currentStep = steps.find((s) => s.id === run.current_step_id);
  if (!currentStep) {
    const updated = await cancelStaleWaitingRun(
      run,
      `Current step ${
        run.current_step_id ?? "(none)"
      } no longer exists in this run's playbook snapshot.`,
    );
    return c.json({ run: updated, result: { action: "cancelled", reason: "stale_current_step" } });
  }

  // For pending_send approvals (ask_customer/send_reply with require_approval),
  // rejection means "don't send this": escalate directly via the shared helper,
  // since there is no on_reject step to route to (that wiring only exists on
  // manual_approval steps, handled below).
  if (currentStep.type === "ask_customer" || currentStep.type === "send_reply") {
    const reason = `Rejected by human: ${currentStep.id} (rejected ${currentStep.type})`;
    await finalizeEscalation(runId, run.thread_id, run.workspace_id, reason, {
      currentStepId: run.current_step_id,
    });
    const updated = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [
      runId,
    ]);
    return c.json({ run: updated, result: { action: "escalated", reason } });
  }

  if (currentStep.type !== "manual_approval") {
    throw new AppError(409, "Current step is not a manual_approval step");
  }

  const approvalStep = currentStep as ManualApprovalStep;
  const nextStepId = approvalStep.on_reject;

  // Record rejection metadata in context so the downstream escalate step can log
  // the real reason ("Rejected by human: approval_1 (Process refund in Stripe)")
  // rather than its own static config string ("Could not find order in sheet").
  const rejectionContext = typeof run.context === "string"
    ? JSON.parse(run.context)
    : { ...run.context };
  rejectionContext._rejection_source = `${currentStep.id} (${approvalStep.reason})`;

  await execute(
    "UPDATE playbook_runs SET status = 'running', current_step_id = $1, context = $2 WHERE id = $3",
    [nextStepId, JSON.stringify(rejectionContext), runId],
  );

  publish({
    type: "run_updated",
    workspaceId: run.workspace_id,
    threadId: run.thread_id,
    run: { ...run, status: "running", current_step_id: nextStepId },
  });
  const rejectedThreadItem = await fetchThreadListItem(run.thread_id, run.workspace_id);
  if (rejectedThreadItem) {
    publish({
      type: "thread_updated",
      workspaceId: run.workspace_id,
      thread: rejectedThreadItem as unknown as Record<string, unknown>,
    });
  }

  const result = await advanceRun(runId);
  const updated = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [runId]);
  return c.json({ run: updated, result });
});

// POST /playbooks/runs/:runId/cancel
playbooksRouter.post("/runs/:runId/cancel", async (c) => {
  const runId = parseInt(c.req.param("runId"));
  if (isNaN(runId)) throw new AppError(400, "Invalid run ID");

  const run = await queryOne<PlaybookRun>(
    "SELECT * FROM playbook_runs WHERE id = $1",
    [runId],
  );
  if (!run) throw new AppError(404, "Run not found");

  const cancellableStatuses = ["running", "waiting_for_customer", "waiting_for_human", "retrying"];
  if (!cancellableStatuses.includes(run.status)) {
    throw new AppError(409, `Run cannot be cancelled (status: ${run.status})`);
  }

  await execute(
    "UPDATE playbook_runs SET status = 'cancelled', updated_at = NOW() WHERE id = $1",
    [runId],
  );

  const updated = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [runId]);
  publish({
    type: "run_updated",
    workspaceId: run.workspace_id,
    threadId: run.thread_id,
    run: { ...run, status: "cancelled" },
  });
  const cancelledThreadItem = await fetchThreadListItem(run.thread_id, run.workspace_id);
  if (cancelledThreadItem) {
    publish({
      type: "thread_updated",
      workspaceId: run.workspace_id,
      thread: cancelledThreadItem as unknown as Record<string, unknown>,
    });
  }
  return c.json({ run: updated });
});

// ─── Playbook CRUD ────────────────────────────────────────────────────────────

// GET /playbooks
playbooksRouter.get("/", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");

  const playbooks = await query<Playbook & { category_name: string | null }>(
    `SELECT p.*, cat.name AS category_name
     FROM playbooks p
     LEFT JOIN categories cat ON cat.id = p.category_id
     WHERE p.workspace_id = $1
     ORDER BY p.updated_at DESC`,
    [workspaceId],
  );

  return c.json({ playbooks });
});

// POST /playbooks
playbooksRouter.post("/", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const body = await c.req.json<{
    name: string;
    category_id?: number | null;
    plain_language_description?: string;
    steps?: PlaybookStep[];
    customer_silence_hours?: number;
    writing_style?: string;
    reply_mode?: "auto_reply" | "draft_only";
    confidence_threshold?: number;
  }>();

  if (!body.name || typeof body.name !== "string") {
    throw new AppError(422, "name is required");
  }
  if (body.category_id === undefined || body.category_id === null) {
    throw new AppError(422, "category_id is required");
  }

  const category = await queryOne<{ id: number }>(
    "SELECT id FROM categories WHERE id = $1 AND workspace_id = $2",
    [body.category_id, workspaceId],
  );
  if (!category) {
    throw new AppError(404, "Category not found");
  }

  const existingForCategory = await queryOne<Pick<Playbook, "id">>(
    "SELECT id FROM playbooks WHERE workspace_id = $1 AND category_id = $2 LIMIT 1",
    [workspaceId, body.category_id],
  );
  if (existingForCategory) {
    throw new AppError(409, "Category already has a playbook");
  }

  const row = await queryOne<Playbook>(
    `INSERT INTO playbooks (workspace_id, category_id, name, plain_language_description, steps, version, is_active, customer_silence_hours, writing_style, reply_mode, confidence_threshold)
     VALUES ($1, $2, $3, $4, $5::jsonb, 1, false, $6, $7, $8, $9)
     RETURNING *`,
    [
      workspaceId,
      body.category_id ?? null,
      body.name.trim(),
      body.plain_language_description ?? null,
      JSON.stringify(body.steps ?? []),
      body.customer_silence_hours ?? 168,
      body.writing_style ?? "",
      body.reply_mode ?? "draft_only",
      body.confidence_threshold ?? 0.8,
    ],
  );

  return c.json({ playbook: row }, 201);
});

// GET /playbooks/:id
playbooksRouter.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid playbook ID");

  const playbook = await queryOne<Playbook & { category_name: string | null }>(
    `SELECT p.*, cat.name AS category_name
     FROM playbooks p
     LEFT JOIN categories cat ON cat.id = p.category_id
     WHERE p.id = $1`,
    [id],
  );
  if (!playbook) throw new AppError(404, "Playbook not found");

  return c.json({ playbook });
});

// PUT /playbooks/:id
playbooksRouter.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid playbook ID");

  const body = await c.req.json<{
    name?: string;
    category_id?: number | null;
    plain_language_description?: string;
    steps?: PlaybookStep[];
    is_active?: boolean;
    customer_silence_hours?: number;
    writing_style?: string;
    reply_mode?: "auto_reply" | "draft_only";
    confidence_threshold?: number;
  }>();

  const existing = await queryOne<Playbook>(
    "SELECT * FROM playbooks WHERE id = $1",
    [id],
  );
  if (!existing) throw new AppError(404, "Playbook not found");

  const newSteps = body.steps !== undefined ? JSON.stringify(body.steps) : JSON.stringify(
    typeof existing.steps === "string" ? JSON.parse(existing.steps) : existing.steps,
  );
  const targetCategoryId = body.category_id !== undefined ? body.category_id : existing.category_id;

  if (targetCategoryId !== null) {
    const category = await queryOne<{ id: number }>(
      "SELECT id FROM categories WHERE id = $1 AND workspace_id = $2",
      [targetCategoryId, existing.workspace_id],
    );
    if (!category) {
      throw new AppError(404, "Category not found");
    }

    const existingForCategory = await queryOne<Pick<Playbook, "id">>(
      "SELECT id FROM playbooks WHERE workspace_id = $1 AND category_id = $2 AND id <> $3 LIMIT 1",
      [existing.workspace_id, targetCategoryId, id],
    );
    if (existingForCategory) {
      throw new AppError(409, "Category already has a playbook");
    }
  }

  const updated = await queryOne<Playbook>(
    `UPDATE playbooks SET
       name = $1,
       category_id = $2,
       plain_language_description = $3,
       steps = $4::jsonb,
       is_active = $5,
       customer_silence_hours = $6,
       writing_style = $7,
       reply_mode = $8,
       confidence_threshold = $9
     WHERE id = $10
     RETURNING *`,
    [
      body.name ?? existing.name,
      targetCategoryId,
      body.plain_language_description !== undefined
        ? body.plain_language_description
        : existing.plain_language_description,
      newSteps,
      body.is_active !== undefined ? body.is_active : existing.is_active,
      body.customer_silence_hours !== undefined
        ? body.customer_silence_hours
        : existing.customer_silence_hours,
      body.writing_style !== undefined ? body.writing_style : existing.writing_style,
      body.reply_mode !== undefined ? body.reply_mode : existing.reply_mode,
      body.confidence_threshold !== undefined
        ? body.confidence_threshold
        : existing.confidence_threshold,
      id,
    ],
  );

  return c.json({ playbook: updated });
});

// DELETE /playbooks/:id
playbooksRouter.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid playbook ID");

  const affected = await execute("DELETE FROM playbooks WHERE id = $1", [id]);
  if (affected === 0) throw new AppError(404, "Playbook not found");

  return c.json({ ok: true });
});

// POST /playbooks/:id/activate
playbooksRouter.post("/:id/activate", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid playbook ID");

  const playbook = await queryOne<Playbook>("SELECT * FROM playbooks WHERE id = $1", [id]);
  if (!playbook) throw new AppError(404, "Playbook not found");

  if (playbook.steps) {
    const steps: PlaybookStep[] = typeof playbook.steps === "string"
      ? JSON.parse(playbook.steps)
      : playbook.steps;
    if (steps.length === 0) {
      throw new AppError(422, "Cannot activate a playbook with no steps");
    }
  }

  const updated = await queryOne<Playbook>(
    "UPDATE playbooks SET is_active = true WHERE id = $1 RETURNING *",
    [id],
  );
  return c.json({ playbook: updated });
});

// POST /playbooks/:id/deactivate
playbooksRouter.post("/:id/deactivate", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid playbook ID");

  const updated = await queryOne<Playbook>(
    "UPDATE playbooks SET is_active = false WHERE id = $1 RETURNING *",
    [id],
  );
  if (!updated) throw new AppError(404, "Playbook not found");

  return c.json({ playbook: updated });
});

// POST /playbooks/:id/dry-run
playbooksRouter.post("/:id/dry-run", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid playbook ID");

  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const body = await c.req.json<{ email_content: string }>();

  if (!body.email_content || typeof body.email_content !== "string") {
    throw new AppError(422, "email_content is required");
  }

  const result = await dryRunPlaybook(id, body.email_content.trim(), workspaceId);
  return c.json(result);
});
