/**
 * API entry point.
 * Bootstraps the Hono application, registers global middleware and routes,
 * runs database migrations, and starts the HTTP server.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";

import { loggerMiddleware } from "./middleware/logger.ts";
import { AppError, ErrorResponse } from "./types/index.ts";
import { logger } from "./services/logger.ts";

import { threadsRouter } from "./routes/threads.ts";
import { categoriesRouter } from "./routes/categories.ts";
import { settingsRouter } from "./routes/settings.ts";
import { authRouter } from "./routes/auth.ts";
import { webhooksRouter } from "./routes/webhooks.ts";
import { workspacesRouter } from "./routes/workspaces.ts";
import { labelsRouter } from "./routes/labels.ts";
import { sheetsRouter } from "./routes/sheets.ts";
import { sheetRulesRouter } from "./routes/sheet-rules.ts";
import { playbooksRouter } from "./routes/playbooks.ts";
import { systemRouter } from "./routes/system.ts";
import { eventsRouter } from "./routes/events.ts";

import { runMigrations } from "./db/migrate.ts";
import { startWatchRenewalLoop, startFallbackPoller } from "./services/watch.ts";
import { startTimeoutWorker } from "./services/playbook/timeout_worker.ts";
import { startRetryWorker } from "./services/playbook/retry_worker.ts";

const PORT = parseInt(Deno.env.get("API_PORT") ?? "8000");
const FRONTEND_ORIGIN = Deno.env.get("FRONTEND_ORIGIN") ?? "http://localhost:3000";

// Run migrations before accepting traffic.
logger.info("startup.migrations_starting");
await runMigrations();
logger.info("startup.migrations_complete");

const app = new Hono();

// ─── Global middleware ────────────────────────────────────────────────────────
app.use("*", loggerMiddleware);
app.use("*", cors({ origin: FRONTEND_ORIGIN, credentials: true }));

// ─── Error handler ────────────────────────────────────────────────────────────
// Must use app.onError - Hono v4 compose() catches route errors internally
// before they can reach a try/catch in middleware.
app.onError((err, c) => {
  if (err instanceof AppError) {
    const body: ErrorResponse = {
      error: { message: err.message, detail: err.detail, status: err.statusCode },
    };
    return c.json(body, err.statusCode as 400 | 401 | 403 | 404 | 409 | 422 | 500);
  }
  logger.error("unhandled_error", { error: String(err) });
  const body: ErrorResponse = {
    error: { message: "Internal server error", status: 500 },
  };
  return c.json(body, 500);
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.route("/threads", threadsRouter);
app.route("/categories", categoriesRouter);
app.route("/settings", settingsRouter);
app.route("/auth", authRouter);
app.route("/webhooks", webhooksRouter);
app.route("/workspaces", workspacesRouter);
app.route("/labels", labelsRouter);
app.route("/sheets", sheetsRouter);
app.route("/sheet-rules", sheetRulesRouter);
app.route("/playbooks", playbooksRouter);
app.route("/events", eventsRouter);
app.route("/system", systemRouter);

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: { message: "Not found", status: 404 } }, 404));

// ─── Background workers ───────────────────────────────────────────────────────
startWatchRenewalLoop();
startFallbackPoller();
startTimeoutWorker();
startRetryWorker();
logger.info("startup.workers_started");

// ─── Server ───────────────────────────────────────────────────────────────────
Deno.serve({ port: PORT }, app.fetch);
logger.info("startup.listening", { port: PORT });
