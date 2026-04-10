/**
 * Request logging middleware.
 * Logs method, path, status code, and duration for every request.
 */
import type { Context, Next } from "npm:hono";

export async function loggerMiddleware(c: Context, next: Next): Promise<void> {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const status = c.res.status;
  console.log(`[${new Date().toISOString()}] ${c.req.method} ${c.req.path} ${status} +${ms}ms`);
}
