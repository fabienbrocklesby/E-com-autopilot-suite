/**
 * Playbook Templates route — /playbook-templates
 * Browse templates and create playbooks from them.
 */
import { Hono } from "hono";
import { query, queryOne } from "../db/client.ts";
import { AppError } from "../types/index.ts";
import { authMiddleware } from "../middleware/auth.ts";
import type { Playbook, PlaybookStep } from "../services/playbook/types.ts";

interface PlaybookTemplate {
  id: number;
  slug: string;
  name: string;
  category: string;
  industry: string | null;
  description: string;
  plain_language: string;
  steps: PlaybookStep[];
  voice_examples: string | null;
  required_sheet_columns: string[] | null;
  is_official: boolean;
  created_at: string;
}

export const playbookTemplatesRouter = new Hono();

playbookTemplatesRouter.use("*", authMiddleware);

// GET /playbook-templates — list all templates
playbookTemplatesRouter.get("/", async (c) => {
  const category = c.req.query("category");
  const industry = c.req.query("industry");
  const search = c.req.query("search");

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }
  if (industry) {
    params.push(industry);
    conditions.push(`industry = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const templates = await query<PlaybookTemplate>(
    `SELECT * FROM playbook_templates ${where} ORDER BY category, name`,
    params,
  );

  return c.json({ templates });
});

// GET /playbook-templates/:slug — single template detail
playbookTemplatesRouter.get("/:slug", async (c) => {
  const slug = c.req.param("slug");

  const template = await queryOne<PlaybookTemplate>(
    "SELECT * FROM playbook_templates WHERE slug = $1",
    [slug],
  );
  if (!template) throw new AppError(404, "Template not found");

  return c.json({ template });
});

// POST /playbooks/from-template — create a playbook from a template
// NOTE: This is registered on the playbooks router, but defined here for co-location.
// The route is mounted at /playbook-templates/create-from in main.ts and the
// actual /playbooks/from-template is added in the playbooks route file.
playbookTemplatesRouter.post("/create-from", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const body = await c.req.json<{
    template_slug: string;
    category_id: number;
    customizations?: {
      name?: string;
      voice_examples?: string;
    };
  }>();

  if (!body.template_slug || typeof body.template_slug !== "string") {
    throw new AppError(422, "template_slug is required");
  }
  if (!body.category_id || typeof body.category_id !== "number") {
    throw new AppError(422, "category_id is required");
  }

  const template = await queryOne<PlaybookTemplate>(
    "SELECT * FROM playbook_templates WHERE slug = $1",
    [body.template_slug],
  );
  if (!template) throw new AppError(404, "Template not found");

  // Verify category exists and belongs to workspace
  const category = await queryOne<{ id: number; workspace_id: number }>(
    "SELECT id, workspace_id FROM categories WHERE id = $1",
    [body.category_id],
  );
  if (!category) throw new AppError(404, "Category not found");
  if (category.workspace_id !== workspaceId) {
    throw new AppError(403, "Category does not belong to this workspace");
  }

  const steps = typeof template.steps === "string"
    ? JSON.parse(template.steps)
    : template.steps;

  const name = body.customizations?.name ?? template.name;

  const playbook = await queryOne<Playbook>(
    `INSERT INTO playbooks (workspace_id, category_id, name, plain_language_description, steps, version, is_active, customer_silence_hours)
     VALUES ($1, $2, $3, $4, $5::jsonb, 1, false, 168)
     RETURNING *`,
    [
      workspaceId,
      body.category_id,
      name,
      template.plain_language,
      JSON.stringify(steps),
    ],
  );

  return c.json({ playbook, template_slug: template.slug }, 201);
});
