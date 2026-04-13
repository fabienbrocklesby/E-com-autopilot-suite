---
name: deno-hono-route
description: How to add a new Hono route to the Deno backend. Use when extending the API with new endpoints. Covers structure, validation, auth, error handling, and registration.
---

# Deno Hono Route Skill

## Where routes live

`api/routes/<resource>.ts` — one file per resource (categories, threads, playbooks, etc.)

## Standard route file

```ts
// api/routes/example.ts
import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { exampleService } from "../services/example.ts";
import { AppError } from "../types/index.ts";

const app = new Hono();
app.use("*", authMiddleware);

// GET /examples
app.get("/", async (c) => {
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const examples = await exampleService.list(workspaceId);
  return c.json(examples);
});

// GET /examples/:id
app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError("Invalid id", 400);

  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const example = await exampleService.getById(id, workspaceId);
  if (!example) throw new AppError("Not found", 404);

  return c.json(example);
});

// POST /examples
app.post("/", async (c) => {
  const body = await c.req.json();
  // Validate manually for now — no Zod yet
  if (!body.name || typeof body.name !== "string") {
    throw new AppError("name is required", 400);
  }
  const workspaceId = parseInt(body.workspace_id ?? "1");
  const created = await exampleService.create({ ...body, workspace_id: workspaceId });
  return c.json(created, 201);
});

// PUT /examples/:id (full update)
app.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError("Invalid id", 400);
  const body = await c.req.json();
  const workspaceId = parseInt(body.workspace_id ?? "1");
  const updated = await exampleService.update(id, workspaceId, body);
  return c.json(updated);
});

// PATCH /examples/:id (partial update)
app.patch("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError("Invalid id", 400);
  const body = await c.req.json();
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  const updated = await exampleService.patch(id, workspaceId, body);
  return c.json(updated);
});

// DELETE /examples/:id
app.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) throw new AppError("Invalid id", 400);
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");
  await exampleService.delete(id, workspaceId);
  return c.body(null, 204);
});

export default app;
```

## Register the route in main.ts

```ts
import exampleRoute from "./routes/example.ts";

app.route("/examples", exampleRoute);
```

## Service layer pattern

Routes are thin. Logic lives in `api/services/<resource>.ts`:

```ts
// api/services/example.ts
import { query, queryOne, execute, transaction } from "../db/client.ts";
import { Example } from "../types/index.ts";

export const exampleService = {
  async list(workspaceId: number): Promise<Example[]> {
    return await query<Example>(
      "SELECT * FROM examples WHERE workspace_id = $1 ORDER BY created_at DESC",
      [workspaceId]
    );
  },

  async getById(id: number, workspaceId: number): Promise<Example | null> {
    return await queryOne<Example>(
      "SELECT * FROM examples WHERE id = $1 AND workspace_id = $2",
      [id, workspaceId]
    );
  },

  async create(input: { name: string; workspace_id: number }): Promise<Example> {
    const created = await queryOne<Example>(
      "INSERT INTO examples (workspace_id, name) VALUES ($1, $2) RETURNING *",
      [input.workspace_id, input.name]
    );
    if (!created) throw new Error("insert failed");
    return created;
  },

  // ... etc
};
```

## Conventions

- **Workspace scoping is mandatory** on every query touching workspace data
- **Throw `AppError(message, status)`** for known errors — the global handler catches it
- **Don't catch errors in routes** unless you're recovering, let them bubble
- **Don't put DB queries in routes** — always go through a service
- **Return `c.json(data)` for success, `c.body(null, 204)` for no-content**
- **POST returns 201 with the created resource**
- **PATCH for partial updates, PUT for full replacement**

## Validation

We don't have Zod or another validation library yet. Manual validation in routes:

```ts
if (!body.field || typeof body.field !== "string") {
  throw new AppError("field is required and must be a string", 400);
}
```

If you find yourself doing this a lot in one route, extract to a helper. If you find yourself doing it across routes, consider proposing a validation library in TASK_LOG.

## Auth

All routes use `authMiddleware` which checks the `Authorization: Bearer <API_SECRET>` header. There's no per-user auth yet.

If you're building a webhook that receives external traffic (Gmail Pub/Sub, etc.), DO NOT use `authMiddleware` — those have their own validation. See `api/routes/webhooks.ts` for the pattern.

## What not to do

- Don't fetch external APIs from a route — that goes in a service
- Don't put OpenAI calls in a route
- Don't write multi-statement DB operations without a transaction (in the service)
- Don't return raw DB rows that include sensitive fields (oauth tokens, etc.) — strip them in the service
