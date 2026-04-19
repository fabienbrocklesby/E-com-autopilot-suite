import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import { AppError } from "../types/index.ts";
import { subscribe } from "../services/event-bus.ts";

export const eventsRouter = new Hono();

const API_SECRET = Deno.env.get("API_SECRET") ?? "";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function authenticate(c: Context): void {
  if (!API_SECRET) throw new AppError(500, "Server misconfiguration: API_SECRET not set");
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : (c.req.query("token") ?? "");
  if (!token || !timingSafeEqual(token, API_SECRET)) {
    throw new AppError(401, "Unauthorized");
  }
}

eventsRouter.get("/workspace", (c) => {
  authenticate(c);
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");

  return streamSSE(c, async (stream) => {
    const unsub = subscribe(workspaceId, (event) => {
      stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
        id: String(Date.now()),
      }).catch(() => {});
    });

    stream.onAbort(() => unsub());

    await stream.writeSSE({ event: "connected", data: "{}", id: "0" });

    while (true) {
      await stream.sleep(30000);
      await stream.writeSSE({ event: "ping", data: "{}" });
    }
  });
});

eventsRouter.get("/thread/:threadId", (c) => {
  authenticate(c);
  const threadId = parseInt(c.req.param("threadId"));
  if (isNaN(threadId)) throw new AppError(400, "Invalid thread ID");
  const workspaceId = parseInt(c.req.query("workspace_id") ?? "1");

  return streamSSE(c, async (stream) => {
    const unsub = subscribe(workspaceId, (event) => {
      const isForThread =
        (event.type === "thread_updated" && (event.thread as { id: number }).id === threadId) ||
        (event.type === "message_created" && event.threadId === threadId) ||
        (event.type === "run_updated" && event.threadId === threadId) ||
        (event.type === "step_execution_created" && event.threadId === threadId) ||
        (event.type === "step_execution_updated" && event.threadId === threadId);

      if (isForThread) {
        stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
          id: String(Date.now()),
        }).catch(() => {});
      }
    });

    stream.onAbort(() => unsub());

    await stream.writeSSE({ event: "connected", data: "{}", id: "0" });

    while (true) {
      await stream.sleep(30000);
      await stream.writeSSE({ event: "ping", data: "{}" });
    }
  });
});
