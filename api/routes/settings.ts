/**
 * Settings route — /settings
 */
import { Hono } from "hono";
import { query, queryOne, execute } from "../db/client.ts";
import { AppError, Setting } from "../types/index.ts";
import { authMiddleware } from "../middleware/auth.ts";

export const settingsRouter = new Hono();

settingsRouter.use("*", authMiddleware);

// GET /settings — returns all key/value pairs as a flat object for convenience
settingsRouter.get("/", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const rows = await query<Setting>(
    "SELECT * FROM settings WHERE workspace_id = $1 ORDER BY key ASC",
    [workspaceId],
  );
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return c.json({ settings: map, rows });
});

// GET /settings/:key
settingsRouter.get("/:key", async (c) => {
  const key = c.req.param("key");
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const setting = await queryOne<Setting>(
    "SELECT * FROM settings WHERE workspace_id = $1 AND key = $2",
    [workspaceId, key],
  );
  if (!setting) throw new AppError(404, `Setting '${key}' not found`);
  return c.json({ setting });
});

// PUT /settings/:key — upsert a setting value
settingsRouter.put("/:key", async (c) => {
  const key = c.req.param("key");
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const body = await c.req.json<{ value: string }>();

  if (typeof body.value !== "string") {
    throw new AppError(422, "value must be a string");
  }

  const setting = await queryOne<Setting>(
    `INSERT INTO settings (workspace_id, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value
     RETURNING *`,
    [workspaceId, key, body.value],
  );
  return c.json({ setting });
});

// DELETE /settings/:key
settingsRouter.delete("/:key", async (c) => {
  const key = c.req.param("key");
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const affected = await execute(
    "DELETE FROM settings WHERE workspace_id = $1 AND key = $2",
    [workspaceId, key],
  );
  if (affected === 0) throw new AppError(404, `Setting '${key}' not found`);
  return c.json({ deleted: true });
});
