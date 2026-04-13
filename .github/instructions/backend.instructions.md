---
applyTo: "api/**"
---

# Backend conventions (Deno + Hono)

## Project layout

- `main.ts` — entry, registers middleware and routes
- `db/client.ts` — Postgres pool, `query`, `queryOne`, `execute`, `transaction`
- `db/migrate.ts` — sequential migration runner
- `db/migrations/*.sql` — append-only migrations
- `middleware/` — Hono middleware (auth, logger). NOT business logic.
- `routes/` — HTTP routes, thin. Validate input, call service, return JSON.
- `services/` — business logic. AI calls, Gmail/Sheets integration, orchestration.
- `types/index.ts` — shared types. Add new types here, don't duplicate inline.

## Routing patterns

```ts
import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { someService } from "../services/something.ts";

const app = new Hono();
app.use("*", authMiddleware);

app.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
  const result = await someService.getById(id);
  if (!result) return c.json({ error: "not found" }, 404);
  return c.json(result);
});

export default app;
```

## Database access

Always use the helpers from `db/client.ts`:

```ts
// Single row
const thread = await queryOne<Thread>(
  "SELECT * FROM threads WHERE id = $1 AND workspace_id = $2",
  [id, workspaceId]
);

// Multiple rows
const threads = await query<Thread>(
  "SELECT * FROM threads WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2",
  [workspaceId, limit]
);

// Write that doesn't return rows
await execute(
  "UPDATE threads SET status = $1 WHERE id = $2",
  [status, id]
);

// Multi-statement: ALWAYS use transaction
await transaction(async (tx) => {
  await tx.queryArray("UPDATE threads SET category_id = $1 WHERE id = $2", [catId, threadId]);
  await tx.queryArray("DELETE FROM drafts WHERE thread_id = $1 AND status = 'pending'", [threadId]);
  await tx.queryArray("INSERT INTO drafts (...) VALUES (...)");
});
```

## Workspace scoping rule

Every query that touches workspace-owned data takes `workspace_id` as a parameter:

```ts
// WRONG
const threads = await query("SELECT * FROM threads WHERE id = $1", [id]);

// RIGHT
const threads = await query(
  "SELECT * FROM threads WHERE id = $1 AND workspace_id = $2",
  [id, workspaceId]
);
```

The only exception: lookups by globally-unique IDs like `gmail_thread_id` where workspace is implied by the OAuth token used to fetch the email.

## OpenAI calls

Use `chatCompletion` from `services/ai.ts`:

```ts
import { chatCompletion } from "./ai.ts";

const response = await chatCompletion({
  workspaceId,
  system: "You are an assistant that...",
  user: "Here is the data: ...",
  responseFormat: "json_object", // or "text"
});
```

Never write a new wrapper. If you need behaviour `chatCompletion` doesn't support, extend it.

## Google API calls (Gmail + Sheets)

Use `getGoogleAccessToken(workspaceId)` from `services/google-auth.ts` (Phase 1+).

Before Phase 1, the duplicated token refresh exists in three places. If you're touching one of them, leave a TODO referencing Phase 1. Don't add a fourth.

## Error handling

Routes throw `AppError` (defined in `types/index.ts`) for known errors:

```ts
throw new AppError("Category not found", 404);
```

The `app.onError()` handler in `main.ts` catches these and returns a proper JSON response. Don't try-catch routes unless you're recovering specifically.

## Tests

We don't have a test suite yet. When adding new logic, include a runnable example in a comment block at the top of the file showing how to invoke it manually via curl or `deno run`. Phase 1 may add proper tests.
