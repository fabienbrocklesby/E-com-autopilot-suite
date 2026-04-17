/**
 * Categories route - /categories
 */
import { Hono } from "hono";
import { query, queryOne, execute } from "../db/client.ts";
import { AppError, Category, CreateCategoryPayload, UpdateCategoryPayload } from "../types/index.ts";
import { authMiddleware } from "../middleware/auth.ts";

export const categoriesRouter = new Hono();

categoriesRouter.use("*", authMiddleware);

// GET /categories
categoriesRouter.get("/", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const categories = await query<Category>(
    "SELECT * FROM categories WHERE workspace_id = $1 ORDER BY name ASC",
    [workspaceId],
  );
  return c.json({ categories });
});

// GET /categories/:id
categoriesRouter.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid category ID");

  const category = await queryOne<Category>(
    "SELECT * FROM categories WHERE id = $1",
    [id],
  );
  if (!category) throw new AppError(404, "Category not found");
  return c.json({ category });
});

// POST /categories
categoriesRouter.post("/", async (c) => {
  const body = await c.req.json<CreateCategoryPayload>();
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  validateCategoryPayload(body);

  const category = await queryOne<Category>(
    `INSERT INTO categories
       (workspace_id, name, description, instructions, allow_auto_reply, confidence_threshold, writing_style)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      workspaceId,
      body.name,
      body.description,
      body.instructions,
      body.allow_auto_reply,
      body.confidence_threshold,
      body.writing_style,
    ],
  );
  return c.json({ category }, 201);
});

// PUT /categories/:id
categoriesRouter.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid category ID");

  const body = await c.req.json<CreateCategoryPayload>();
  validateCategoryPayload(body);

  const category = await queryOne<Category>(
    `UPDATE categories
     SET name = $1, description = $2, instructions = $3,
         allow_auto_reply = $4, confidence_threshold = $5, writing_style = $6
     WHERE id = $7
     RETURNING *`,
    [
      body.name,
      body.description,
      body.instructions,
      body.allow_auto_reply,
      body.confidence_threshold,
      body.writing_style,
      id,
    ],
  );
  if (!category) throw new AppError(404, "Category not found");
  return c.json({ category });
});

// PATCH /categories/:id
categoriesRouter.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid category ID");

  const body = await c.req.json<UpdateCategoryPayload>();

  // Build dynamic SET clause from provided fields only
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  const allowed: (keyof UpdateCategoryPayload)[] = [
    "name", "description", "instructions", "allow_auto_reply",
    "confidence_threshold", "writing_style",
  ];

  for (const key of allowed) {
    if (body[key] !== undefined) {
      fields.push(`${key} = $${paramIndex++}`);
      values.push(body[key]);
    }
  }

  if (fields.length === 0) throw new AppError(422, "No fields to update");

  values.push(id);
  const category = await queryOne<Category>(
    `UPDATE categories SET ${fields.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );
  if (!category) throw new AppError(404, "Category not found");
  return c.json({ category });
});

// DELETE /categories/:id
categoriesRouter.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError(400, "Invalid category ID");

  const affected = await execute(
    "DELETE FROM categories WHERE id = $1",
    [id],
  );
  if (affected === 0) throw new AppError(404, "Category not found");
  return c.json({ deleted: true });
});

function validateCategoryPayload(body: CreateCategoryPayload): void {
  if (!body.name?.trim()) throw new AppError(422, "name is required");
  if (
    typeof body.confidence_threshold !== "number" ||
    body.confidence_threshold < 0 ||
    body.confidence_threshold > 1
  ) {
    throw new AppError(422, "confidence_threshold must be a number between 0 and 1");
  }
}
