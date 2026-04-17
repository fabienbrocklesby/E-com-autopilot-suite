/**
 * Sheet Rules route - /sheet-rules
 * CRUD for sheet rules and management of their executions.
 * All routes require auth.
 */
import { Hono } from "hono";
import { query, queryOne, execute } from "../db/client.ts";
import {
  AppError,
  SheetRule,
  SheetRuleExecution,
  CreateSheetRulePayload,
  UpdateSheetRulePayload,
  RuleUpdateDefinition,
} from "../types/index.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { approveExecution, rejectExecution, retryExecution } from "../services/sheet-rules.ts";

export const sheetRulesRouter = new Hono();

sheetRulesRouter.use("*", authMiddleware);

// ─── Executions sub-routes (must be defined before /:id patterns) ─────────────

// GET /sheet-rules/executions?workspace_id=N&status=pending
sheetRulesRouter.get("/executions", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const statusFilter = c.req.query("status") ?? null;
  const limitParam = c.req.query("limit");
  const offsetParam = c.req.query("offset");

  const limit = Math.min(parseInt(limitParam ?? "50"), 200);
  const offset = parseInt(offsetParam ?? "0");

  const executions = await query<SheetRuleExecution & { rule_name: string; thread_subject: string | null }>(
    `SELECT
       e.*,
       r.name AS rule_name,
       t.subject AS thread_subject
     FROM sheet_rule_executions e
     JOIN sheet_rules r ON r.id = e.rule_id
     LEFT JOIN threads t ON t.id = e.thread_id
     WHERE e.workspace_id = $1
       AND ($2::text IS NULL OR e.status = $2)
     ORDER BY e.created_at DESC
     LIMIT $3 OFFSET $4`,
    [workspaceId, statusFilter, limit, offset],
  );

  return c.json({ executions, limit, offset });
});

// POST /sheet-rules/executions/:id/approve
sheetRulesRouter.post("/executions/:id/approve", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid execution ID");

  await approveExecution(id);
  const execution = await queryOne<SheetRuleExecution>(
    "SELECT * FROM sheet_rule_executions WHERE id = $1",
    [id],
  );
  return c.json({ execution });
});

// POST /sheet-rules/executions/:id/reject
sheetRulesRouter.post("/executions/:id/reject", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid execution ID");

  await rejectExecution(id);
  const execution = await queryOne<SheetRuleExecution>(
    "SELECT * FROM sheet_rule_executions WHERE id = $1",
    [id],
  );
  return c.json({ execution });
});

// POST /sheet-rules/executions/:id/retry
sheetRulesRouter.post("/executions/:id/retry", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid execution ID");

  // Capture rule_id + thread_id before retryExecution may delete the record.
  const existing = await queryOne<SheetRuleExecution>(
    "SELECT rule_id, thread_id FROM sheet_rule_executions WHERE id = $1",
    [id],
  );
  if (!existing) throw new AppError(404, "Execution not found");

  await retryExecution(id);

  // Fetch the newest execution for this rule+thread (the one just created or updated).
  const execution = await queryOne<SheetRuleExecution>(
    `SELECT e.*,
            r.name AS rule_name,
            t.subject AS thread_subject
     FROM sheet_rule_executions e
     LEFT JOIN sheet_rules r ON r.id = e.rule_id
     LEFT JOIN threads t ON t.id = e.thread_id
     WHERE e.rule_id = $1 AND e.thread_id = $2
     ORDER BY e.id DESC
     LIMIT 1`,
    [existing.rule_id, existing.thread_id],
  );
  return c.json({ execution });
});

// ─── Rules CRUD ───────────────────────────────────────────────────────────────

// GET /sheet-rules?workspace_id=N
sheetRulesRouter.get("/", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const rules = await query<SheetRule>(
    "SELECT * FROM sheet_rules WHERE workspace_id = $1 ORDER BY name ASC",
    [workspaceId],
  );
  return c.json({ rules });
});

// POST /sheet-rules
sheetRulesRouter.post("/", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const body = await c.req.json<CreateSheetRulePayload>();
  validateRulePayload(body);

  const rule = await queryOne<SheetRule>(
    `INSERT INTO sheet_rules
       (workspace_id, name, description, is_active, category_ids, match_instruction, match_column, updates, auto_apply)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      workspaceId,
      body.name,
      body.description,
      body.is_active,
      body.category_ids ? body.category_ids : null,
      body.match_instruction,
      body.match_column,
      JSON.stringify(body.updates),
      body.auto_apply,
    ],
  );
  return c.json({ rule }, 201);
});

// GET /sheet-rules/:id
sheetRulesRouter.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid rule ID");

  const rule = await queryOne<SheetRule>(
    "SELECT * FROM sheet_rules WHERE id = $1",
    [id],
  );
  if (!rule) throw new AppError(404, "Sheet rule not found");
  return c.json({ rule });
});

// PUT /sheet-rules/:id - full replacement
sheetRulesRouter.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid rule ID");

  const body = await c.req.json<CreateSheetRulePayload>();
  validateRulePayload(body);

  const rule = await queryOne<SheetRule>(
    `UPDATE sheet_rules
     SET name = $1, description = $2, is_active = $3, category_ids = $4,
         match_instruction = $5, match_column = $6, updates = $7, auto_apply = $8
     WHERE id = $9
     RETURNING *`,
    [
      body.name,
      body.description,
      body.is_active,
      body.category_ids ? body.category_ids : null,
      body.match_instruction,
      body.match_column,
      JSON.stringify(body.updates),
      body.auto_apply,
      id,
    ],
  );
  if (!rule) throw new AppError(404, "Sheet rule not found");
  return c.json({ rule });
});

// PATCH /sheet-rules/:id - partial update (e.g. is_active toggle)
sheetRulesRouter.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid rule ID");

  const body = await c.req.json<UpdateSheetRulePayload>();
  const allowedKeys: (keyof UpdateSheetRulePayload)[] = [
    "name", "description", "is_active", "category_ids",
    "match_instruction", "match_column", "updates", "auto_apply",
  ];

  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const key of allowedKeys) {
    if (key in body) {
      if (key === "updates") {
        fields.push(`${key} = $${paramIndex++}`);
        values.push(JSON.stringify(body.updates));
      } else if (key === "category_ids") {
        fields.push(`${key} = $${paramIndex++}`);
        values.push(body.category_ids ? body.category_ids : null);
      } else {
        fields.push(`${key} = $${paramIndex++}`);
        values.push(body[key]);
      }
    }
  }

  if (!fields.length) throw new AppError(422, "No valid fields to update");

  values.push(id);
  const rule = await queryOne<SheetRule>(
    `UPDATE sheet_rules SET ${fields.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );
  if (!rule) throw new AppError(404, "Sheet rule not found");
  return c.json({ rule });
});

// DELETE /sheet-rules/:id
sheetRulesRouter.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid rule ID");

  const affected = await execute("DELETE FROM sheet_rules WHERE id = $1", [id]);
  if (affected === 0) throw new AppError(404, "Sheet rule not found");
  return c.json({ deleted: true });
});

// ─── Validation ───────────────────────────────────────────────────────────────

function validateRulePayload(body: CreateSheetRulePayload): void {
  if (!body.name?.trim()) throw new AppError(422, "name is required");
  if (!body.match_instruction?.trim()) throw new AppError(422, "match_instruction is required");
  if (!body.match_column?.trim()) throw new AppError(422, "match_column is required");
  if (!Array.isArray(body.updates)) throw new AppError(422, "updates must be an array");

  for (const upd of body.updates as RuleUpdateDefinition[]) {
    if (!upd.column?.trim()) throw new AppError(422, "Each update must have a column");
    if (upd.mode !== "fixed" && upd.mode !== "ai") {
      throw new AppError(422, `Update mode must be "fixed" or "ai", got "${upd.mode}"`);
    }
    if (upd.mode === "fixed" && typeof upd.value !== "string") {
      throw new AppError(422, `Fixed update for "${upd.column}" must have a value`);
    }
    if (upd.mode === "ai" && !upd.instruction?.trim()) {
      throw new AppError(422, `AI update for "${upd.column}" must have an instruction`);
    }
  }
}
