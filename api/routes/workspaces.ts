/**
 * Workspaces route — /workspaces
 * CRUD for workspaces plus label-sync trigger.
 */
import { Hono } from "hono";
import { query, queryOne, execute } from "../db/client.ts";
import {
  AppError,
  Workspace,
  CreateWorkspacePayload,
  UpdateWorkspacePayload,
} from "../types/index.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { syncLabels } from "../services/gmail.ts";

export const workspacesRouter = new Hono();

workspacesRouter.use("*", authMiddleware);

// GET /workspaces
workspacesRouter.get("/", async (c) => {
  const workspaces = await query<Workspace>(
    "SELECT * FROM workspaces ORDER BY id ASC",
  );
  return c.json({ workspaces });
});

// GET /workspaces/:id
workspacesRouter.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid workspace ID");

  const workspace = await queryOne<Workspace>(
    "SELECT * FROM workspaces WHERE id = $1",
    [id],
  );
  if (!workspace) throw new AppError(404, "Workspace not found");
  return c.json({ workspace });
});

// POST /workspaces
workspacesRouter.post("/", async (c) => {
  const body = await c.req.json<CreateWorkspacePayload>();
  if (!body.name?.trim()) throw new AppError(422, "name is required");

  const workspace = await queryOne<Workspace>(
    `INSERT INTO workspaces (name, gmail_address, sheet_id, sheet_name)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [
      body.name.trim(),
      body.gmail_address ?? null,
      body.sheet_id ?? null,
      body.sheet_name ?? "Sheet1",
    ],
  );
  return c.json({ workspace }, 201);
});

// PATCH /workspaces/:id
workspacesRouter.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid workspace ID");

  const body = await c.req.json<UpdateWorkspacePayload>();
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  const allowed: (keyof UpdateWorkspacePayload)[] = [
    "name", "gmail_address", "sheet_id", "sheet_name",
  ];
  for (const key of allowed) {
    if (body[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      values.push(body[key]);
    }
  }
  if (fields.length === 0) throw new AppError(422, "No fields to update");

  values.push(id);
  const workspace = await queryOne<Workspace>(
    `UPDATE workspaces SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
    values,
  );
  if (!workspace) throw new AppError(404, "Workspace not found");
  return c.json({ workspace });
});

// DELETE /workspaces/:id — prevent deletion of the last workspace
workspacesRouter.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid workspace ID");

  const count = await queryOne<{ count: string }>(
    "SELECT COUNT(*) AS count FROM workspaces",
  );
  if (parseInt(count?.count ?? "0") <= 1) {
    throw new AppError(422, "Cannot delete the last workspace");
  }

  const affected = await execute("DELETE FROM workspaces WHERE id = $1", [id]);
  if (affected === 0) throw new AppError(404, "Workspace not found");
  return c.json({ deleted: true });
});

// POST /workspaces/:id/sync-labels — pull Gmail labels into categories
workspacesRouter.post("/:id/sync-labels", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid workspace ID");

  const workspace = await queryOne<Workspace>(
    "SELECT * FROM workspaces WHERE id = $1",
    [id],
  );
  if (!workspace) throw new AppError(404, "Workspace not found");
  if (!workspace.gmail_address) {
    throw new AppError(422, "Workspace has no gmail_address configured");
  }

  const synced = await syncLabels(workspace.gmail_address, id);
  return c.json({ synced });
});
