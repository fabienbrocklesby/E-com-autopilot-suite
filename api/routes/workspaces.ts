/**
 * Workspaces route - /workspaces
 * CRUD for workspaces plus label-sync trigger.
 */
import { Hono } from "hono";
import { execute, query, queryOne } from "../db/client.ts";
import {
  AppError,
  CreateWorkspacePayload,
  UpdateWorkspacePayload,
  Workspace,
} from "../types/index.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { syncLabels } from "../services/gmail.ts";

export const workspacesRouter = new Hono();

workspacesRouter.use("*", authMiddleware);

const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{30,}$/;

function normaliseSheetId(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? trimmed;
}

function normaliseSheetName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() || "Sheet1";
}

function validateSheetConfig(
  sheetId: string | null | undefined,
  sheetName: string | undefined,
): void {
  if (!sheetName || sheetId === null) return;

  if (sheetId && sheetName === sheetId) {
    throw new AppError(422, "Sheet name must be the tab name, not the spreadsheet ID");
  }

  if (SPREADSHEET_ID_PATTERN.test(sheetName)) {
    throw new AppError(
      422,
      "Sheet name looks like a spreadsheet ID. Use the tab name at the bottom of the Google Sheet, for example Sheet1.",
    );
  }
}

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
  const sheetId = normaliseSheetId(body.sheet_id);
  const sheetName = normaliseSheetName(body.sheet_name);
  validateSheetConfig(sheetId, sheetName);

  const workspace = await queryOne<Workspace>(
    `INSERT INTO workspaces (name, gmail_address, sheet_id, sheet_name, store_name, store_description, store_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      body.name.trim(),
      body.gmail_address ?? null,
      sheetId ?? null,
      sheetName ?? "Sheet1",
      body.store_name ?? null,
      body.store_description ?? null,
      body.store_url ?? null,
    ],
  );
  return c.json({ workspace }, 201);
});

// PATCH /workspaces/:id
workspacesRouter.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid workspace ID");

  const body = await c.req.json<UpdateWorkspacePayload>();
  const sheetId = normaliseSheetId(body.sheet_id);
  const sheetName = normaliseSheetName(body.sheet_name);
  validateSheetConfig(sheetId, sheetName);
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  const allowed: (keyof UpdateWorkspacePayload)[] = [
    "name",
    "gmail_address",
    "sheet_id",
    "sheet_name",
    "store_name",
    "store_description",
    "store_url",
  ];
  for (const key of allowed) {
    if (body[key] !== undefined) {
      fields.push(`${key} = $${idx++}`);
      if (key === "sheet_id") values.push(sheetId);
      else if (key === "sheet_name") values.push(sheetName);
      else values.push(body[key]);
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

// DELETE /workspaces/:id - prevent deletion of the last workspace
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

// POST /workspaces/:id/sync-labels - pull Gmail labels into categories
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
