/**
 * Playbooks route — /playbooks
 * CRUD, parser, dry-run, run management, and manual approval.
 */
import { Hono } from "hono";
import { query, queryOne, execute } from "../db/client.ts";
import { AppError } from "../types/index.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { parsePlaybook } from "../services/playbook/parser.ts";
import { dryRunPlaybook } from "../services/playbook/dry-run.ts";
import { advanceRun } from "../services/playbook/mod.ts";
import type { Playbook, PlaybookRun, StepExecution, ManualApprovalStep, PlaybookStep } from "../services/playbook/types.ts";

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

  const runs = await query<PlaybookRun & { playbook_name: string; step_reason: string | null }>(
    `SELECT pr.*, p.name AS playbook_name,
      CASE WHEN pr.status = 'waiting_for_human'
        THEN (
          SELECT (step->>'reason')
          FROM jsonb_array_elements(p.steps) AS step
          WHERE step->>'id' = pr.current_step_id
            AND step->>'type' = 'manual_approval'
          LIMIT 1
        )
        ELSE NULL
      END AS step_reason
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

  const steps: PlaybookStep[] =
    typeof playbook.steps === "string" ? JSON.parse(playbook.steps) : playbook.steps;

  const currentStep = steps.find((s) => s.id === run.current_step_id);
  if (!currentStep || currentStep.type !== "manual_approval") {
    throw new AppError(409, "Current step is not a manual_approval step");
  }

  const approvalStep = currentStep as ManualApprovalStep;
  const nextStepId = approvalStep.on_approve;

  await execute(
    "UPDATE playbook_runs SET status = 'running', current_step_id = $1 WHERE id = $2",
    [nextStepId, runId],
  );

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

  const steps: PlaybookStep[] =
    typeof playbook.steps === "string" ? JSON.parse(playbook.steps) : playbook.steps;

  const currentStep = steps.find((s) => s.id === run.current_step_id);
  if (!currentStep || currentStep.type !== "manual_approval") {
    throw new AppError(409, "Current step is not a manual_approval step");
  }

  const approvalStep = currentStep as ManualApprovalStep;
  const nextStepId = approvalStep.on_reject;

  await execute(
    "UPDATE playbook_runs SET status = 'running', current_step_id = $1 WHERE id = $2",
    [nextStepId, runId],
  );

  const result = await advanceRun(runId);
  const updated = await queryOne<PlaybookRun>("SELECT * FROM playbook_runs WHERE id = $1", [runId]);
  return c.json({ run: updated, result });
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
  }>();

  if (!body.name || typeof body.name !== "string") {
    throw new AppError(422, "name is required");
  }

  const row = await queryOne<Playbook>(
    `INSERT INTO playbooks (workspace_id, category_id, name, plain_language_description, steps, version, is_active)
     VALUES ($1, $2, $3, $4, $5::jsonb, 1, false)
     RETURNING *`,
    [
      workspaceId,
      body.category_id ?? null,
      body.name.trim(),
      body.plain_language_description ?? null,
      JSON.stringify(body.steps ?? []),
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
  }>();

  const existing = await queryOne<Playbook>(
    "SELECT * FROM playbooks WHERE id = $1",
    [id],
  );
  if (!existing) throw new AppError(404, "Playbook not found");

  // Bump version if steps changed
  const existingSteps = JSON.stringify(
    typeof existing.steps === "string" ? JSON.parse(existing.steps) : existing.steps,
  );
  const newSteps = body.steps !== undefined ? JSON.stringify(body.steps) : existingSteps;
  const stepsChanged = newSteps !== existingSteps;
  const newVersion = stepsChanged ? existing.version + 1 : existing.version;

  const updated = await queryOne<Playbook>(
    `UPDATE playbooks SET
       name = $1,
       category_id = $2,
       plain_language_description = $3,
       steps = $4::jsonb,
       version = $5,
       is_active = $6
     WHERE id = $7
     RETURNING *`,
    [
      body.name ?? existing.name,
      body.category_id !== undefined ? body.category_id : existing.category_id,
      body.plain_language_description !== undefined
        ? body.plain_language_description
        : existing.plain_language_description,
      newSteps,
      newVersion,
      body.is_active !== undefined ? body.is_active : existing.is_active,
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
    const steps: PlaybookStep[] =
      typeof playbook.steps === "string" ? JSON.parse(playbook.steps) : playbook.steps;
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
