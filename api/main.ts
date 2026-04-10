/**
 * API entry point.
 * Bootstraps the Hono application, registers global middleware and routes,
 * runs database migrations, and starts the HTTP server.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";

import { loggerMiddleware } from "./middleware/logger.ts";
import { errorMiddleware } from "./middleware/error.ts";

import { threadsRouter } from "./routes/threads.ts";
import { categoriesRouter } from "./routes/categories.ts";
import { settingsRouter } from "./routes/settings.ts";
import { authRouter } from "./routes/auth.ts";
import { webhooksRouter } from "./routes/webhooks.ts";

import { runMigrations } from "./db/migrate.ts";

const PORT = parseInt(Deno.env.get("API_PORT") ?? "8000");
const FRONTEND_ORIGIN = Deno.env.get("FRONTEND_ORIGIN") ?? "http://localhost:3000";

// Run migrations before accepting traffic.
console.log("[startup] Running database migrations…");
await runMigrations();
console.log("[startup] Migrations complete. Starting HTTP server…");

const app = new Hono();

// ─── Global middleware ────────────────────────────────────────────────────────
app.use("*", loggerMiddleware);
app.use("*", cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use("*", errorMiddleware);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.route("/threads", threadsRouter);
app.route("/categories", categoriesRouter);
app.route("/settings", settingsRouter);
app.route("/auth", authRouter);
app.route("/webhooks", webhooksRouter);

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: { message: "Not found", status: 404 } }, 404));

// ─── Server ───────────────────────────────────────────────────────────────────
Deno.serve({ port: PORT }, app.fetch);
console.log(`[startup] API listening on http://localhost:${PORT}`);
