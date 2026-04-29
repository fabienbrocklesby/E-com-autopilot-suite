/**
 * Sheets route - /sheets
 * Endpoints for managing and inspecting the Google Sheets integration.
 */
import { Hono } from "hono";
import { query, queryOne } from "../db/client.ts";
import { AppError, SheetColumn, SheetUpdate, Workspace } from "../types/index.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { readColumnHeaders, syncColumns } from "../services/sheets.ts";

export const sheetsRouter = new Hono();

sheetsRouter.use("*", authMiddleware);

const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{30,}$/;

// GET /sheets/columns?workspace_id=1 - list synced column headers
sheetsRouter.get("/columns", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  if (isNaN(workspaceId)) throw new AppError(400, "Invalid workspace_id");

  const columns = await query<SheetColumn>(
    "SELECT * FROM sheet_columns WHERE workspace_id = $1 ORDER BY column_letter ASC",
    [workspaceId],
  );
  return c.json({ columns });
});

// POST /sheets/sync-columns?workspace_id=1 - read sheet headers and persist
sheetsRouter.post("/sync-columns", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  if (isNaN(workspaceId)) throw new AppError(400, "Invalid workspace_id");

  const workspace = await queryOne<Workspace>(
    "SELECT * FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  if (!workspace) throw new AppError(404, "Workspace not found");
  if (!workspace.sheet_id) throw new AppError(422, "Workspace has no sheet_id configured");
  if (
    workspace.sheet_name === workspace.sheet_id || SPREADSHEET_ID_PATTERN.test(workspace.sheet_name)
  ) {
    throw new AppError(
      422,
      "Workspace sheet_name is set to a spreadsheet ID. Edit the workspace and set Sheet name to the tab name, for example Sheet1.",
    );
  }

  // Get the Gmail email for OAuth token lookup.
  const tokenRow = await queryOne<{ email: string }>(
    "SELECT email FROM oauth_tokens WHERE workspace_id = $1 ORDER BY id DESC LIMIT 1",
    [workspaceId],
  );
  if (!tokenRow) throw new AppError(422, "No connected Gmail account for this workspace");

  const columnMap = await readColumnHeaders(
    tokenRow.email,
    workspace.sheet_id,
    workspace.sheet_name,
  );
  await syncColumns(workspaceId, columnMap);

  const columns = Array.from(columnMap.entries()).map(([letter, name]) => ({
    column_letter: letter,
    header_name: name,
  }));
  return c.json({ columns });
});

// GET /sheets/updates?workspace_id=1&limit=50&offset=0 - audit log
sheetsRouter.get("/updates", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 200);
  const offset = parseInt(c.req.query("offset") ?? "0");

  if (isNaN(workspaceId)) throw new AppError(400, "Invalid workspace_id");

  const updates = await query<SheetUpdate>(
    `SELECT * FROM sheet_updates
     WHERE workspace_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [workspaceId, limit, offset],
  );
  return c.json({ updates, limit, offset });
});
