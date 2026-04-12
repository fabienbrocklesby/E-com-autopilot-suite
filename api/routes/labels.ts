/**
 * Labels route — /labels
 * Provides label list and manual sync for a workspace.
 */
import { Hono } from "hono";
import { queryOne } from "../db/client.ts";
import { AppError, Workspace } from "../types/index.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { syncLabels } from "../services/gmail.ts";

export const labelsRouter = new Hono();

labelsRouter.use("*", authMiddleware);

// POST /labels/sync?workspace_id=1 — trigger label sync for a workspace
labelsRouter.post("/sync", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  if (isNaN(workspaceId)) throw new AppError(400, "Invalid workspace_id");

  const workspace = await queryOne<Workspace>(
    "SELECT * FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  if (!workspace) throw new AppError(404, "Workspace not found");
  if (!workspace.gmail_address) {
    throw new AppError(422, "Workspace has no gmail_address configured");
  }

  const synced = await syncLabels(workspace.gmail_address, workspaceId);
  return c.json({ synced });
});
