# Live Updates Plan

## Problem

Every page that shows thread or playbook data requires a full browser refresh or a manual reload button press. The inbox doesn't update when a new email arrives via the Gmail webhook, and the thread detail page doesn't show playbook step progress in real time.

## Approach: Server-Sent Events

### Why SSE and not WebSockets

All data flows in one direction: server pushes state changes to the browser. Emails arrive via Gmail webhook → backend processes them → frontend learns about it. The browser never needs to push live data to the server; it uses normal REST calls for user actions (approvals, status changes, manual replies).

SSE maps perfectly onto this model:
- Hono has a first-class `streamSSE` helper (from `hono/streaming`) — no extra packages needed
- `EventSource` is native in every modern browser and auto-reconnects on drop
- Single unidirectional HTTP stream, trivially CORS-compatible with the existing `cors()` config
- Zero additional infrastructure — no WebSocket upgrade, no separate broker process

Docs consulted: https://hono.dev/docs/helpers/streaming (`streamSSE`, `onAbort`, `stream.sleep`)

### Why in-memory event bus and not Postgres LISTEN/NOTIFY

The backend is a single Deno process on a single server (Docker Compose / Dokploy single-VPS). An in-process module-level subscriber map is:
- Zero overhead per event (no DB round-trip)
- Zero connection management (no dedicated LISTEN connection)
- Trivially typed and testable

Postgres `LISTEN/NOTIFY` would be the right upgrade if the backend ever scales to multiple processes. The event-bus module interface is designed so the publish/subscribe contract stays the same regardless of the underlying transport, making that migration surgical when needed.

### Auth for SSE: token in query parameter

Browser-native `EventSource` cannot send custom HTTP headers. The backend currently uses `Authorization: Bearer <token>` everywhere. Options:

1. Token in query param: `?token=xxx` — simple, works with native `EventSource`
2. `@microsoft/fetch-event-source` library — replaces EventSource with a fetch-based polyfill that supports headers, but adds a frontend dependency and about 3kb
3. Cookie auth — not currently used anywhere in the project

This is a single-tenant internal tool with a single `API_SECRET`. The token is already stored in plain `localStorage`. Leaking it to server logs via query param is the same risk profile as the existing `Authorization` header approach. Option 1 is chosen.

The SSE auth handler checks `?token=` when `Authorization` header is absent, using the same constant-time comparison. Regular non-SSE routes are not changed.

---

## Event Model

### Event types and payloads

All events are namespaced by type. The SSE `event:` field carries the type; `data:` carries JSON.

| event name | when emitted | payload |
|---|---|---|
| `thread_created` | New gmail thread ingested | Full `ThreadListItem` shape |
| `thread_updated` | Thread status changed, category assigned, draft updated | Full `ThreadListItem` shape |
| `message_created` | New message inserted for a thread | `{ thread_id, message: Message }` |
| `run_updated` | Run status changed (any transition) | `{ thread_id, run: PlaybookRun }` |
| `step_execution_created` | Executor records a step as `running` | `{ run_id, execution: StepExecution }` |
| `step_execution_updated` | Executor marks step success/failed | `{ run_id, execution: StepExecution }` |

The `thread_created` and `thread_updated` payloads carry the full denormalized shape (same columns as the existing `GET /threads` list query) so the frontend doesn't need a follow-up request.

For `thread_created` vs `thread_updated` from `gmail.ts`: the existing upsert uses `ON CONFLICT ... DO UPDATE`. We add `(xmax = 0) AS is_new_row` to the `RETURNING` clause to distinguish first insert from update without a separate SELECT.

---

## Backend Changes

### New file: `api/services/event-bus.ts`

Module-level singleton. Exports:

```typescript
type BusEvent =
  | { type: 'thread_created'; workspaceId: number; thread: ThreadListItem }
  | { type: 'thread_updated'; workspaceId: number; thread: ThreadListItem }
  | { type: 'message_created'; workspaceId: number; threadId: number; message: Message }
  | { type: 'run_updated'; workspaceId: number; threadId: number; run: PlaybookRun }
  | { type: 'step_execution_created'; workspaceId: number; runId: number; execution: StepExecution }
  | { type: 'step_execution_updated'; workspaceId: number; runId: number; execution: StepExecution }

function publish(event: BusEvent): void
function subscribe(workspaceId: number, callback: (event: BusEvent) => void): () => void
```

`subscribe` returns an unsubscribe function. Internally uses a `Map<number, Set<(e: BusEvent) => void>>` keyed by `workspaceId`. Each SSE connection calls `subscribe`, and the unsubscribe function is called in the `stream.onAbort` handler to prevent memory leaks.

### New file: `api/routes/events.ts`

Two endpoints:

**`GET /events/workspace`**

Query params: `workspace_id` (default 1), `token` (auth fallback).

Uses `streamSSE`. Subscribes to all events for the workspace. Sends a `connected` event immediately to confirm the stream is live. Then loops with `stream.sleep(30000)` sending `ping` heartbeats to keep the connection alive through proxies. The subscriber callback writes events to the stream directly from the event bus callback.

```typescript
return streamSSE(c, async (stream) => {
  const unsub = subscribe(workspaceId, (event) => {
    stream.writeSSE({ event: event.type, data: JSON.stringify(event), id: String(Date.now()) })
  })
  stream.onAbort(() => unsub())
  await stream.writeSSE({ event: 'connected', data: '{}', id: '0' })
  while (true) {
    await stream.sleep(30000)
    await stream.writeSSE({ event: 'ping', data: '{}' })
  }
})
```

**`GET /events/thread/:id`**

Same pattern but the subscriber callback filters events to those matching `threadId` (message_created, run_updated, step_execution_*) or the thread itself (thread_updated).

Both endpoints have a custom auth check that accepts `?token=` as fallback to `Authorization` header.

### Modifications to `api/main.ts`

Register the events router: `app.route('/events', eventsRouter)`.

### Modifications to `api/services/gmail.ts`

After the thread upsert, fetch the full denormalized row (same query shape as `GET /threads` list) and publish:
- `thread_created` if `is_new_row` is true
- `thread_updated` if the thread already existed

After the message insert, publish `message_created`.

The full denormalized thread fetch is extracted into a shared helper `fetchThreadListItem(threadId, workspaceId)` placed in `api/db/queries.ts` (new file). This same helper is also used by `routes/threads.ts` to avoid duplicating the large JOIN query.

### Modifications to `api/services/playbook/executor.ts`

After the `INSERT INTO playbook_step_executions` that records a step as `running`, publish `step_execution_created`.

After the `UPDATE playbook_step_executions` that sets status to success/failed, publish `step_execution_updated`.

After every `UPDATE playbook_runs` that changes status (pause, complete, fail, retrying), publish `run_updated`.

These are fire-and-no-wait calls (the event bus publish is synchronous in-memory — no await needed).

### Modifications to `api/routes/threads.ts`

After `PATCH /:id/status`, publish `thread_updated` using the `fetchThreadListItem` helper.

After `PATCH /:id/drafts/:draftId`, publish `thread_updated` (draft status change affects `has_pending_action`, which affects urgency grouping in the inbox).

### New file: `api/db/queries.ts`

Extracts the large denormalized thread SELECT (currently duplicated in `routes/threads.ts`) into `fetchThreadListItem(threadId, workspaceId): Promise<ThreadListItem | null>`. Used by both the routes and the event publishers.

---

## Frontend Changes

### New file: `frontend/src/lib/sse.ts`

A thin helper that builds the SSE URL with auth token from localStorage and returns a configured `EventSource`. Not a Svelte store — just a factory function used in `$effect` blocks.

```typescript
export function openSSE(path: string, params: Record<string, string | number> = {}): EventSource {
  const token = localStorage.getItem('api_token') ?? ''
  const qs = new URLSearchParams({ token, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) })
  return new EventSource(`${BASE_URL}/events/${path}?${qs}`)
}
```

### Modifications to `frontend/src/lib/api.ts`

No structural changes. The SSE helper lives in `sse.ts` to keep the api.ts contract (returns Promises) clean and separate from event streams.

### Modifications to `frontend/src/routes/+page.svelte` (inbox)

Add a `$effect` after `onMount` that:
1. Opens a workspace SSE stream via `openSSE('workspace', { workspace_id: currentWorkspaceId })`
2. Listens for `thread_created`: inserts the new ThreadListItem into the start of the `threads` array if not already present
3. Listens for `thread_updated`: replaces the matching item in `threads`, or appends if not found (handles edge cases where thread was visible in a different account)
4. Listens for `open` (reconnect): sets a flag that triggers a call to `loadThreads()` to resync any missed events
5. Returns teardown that closes the EventSource

The first `open` event fires immediately on connect (not a reconnect). A boolean `hasConnectedOnce` distinguishes initial connect (no reload needed, data was already fetched) from subsequent reconnects (reload needed to catch up).

Because `threads` is `$state`, and `grouped` is `$derived.by`, any mutation to `threads` automatically recomputes the grouped sections and triggers Svelte's fine-grained DOM diffing. New threads animate in via the existing `fly` transition.

### Modifications to `frontend/src/routes/threads/[id]/+page.svelte` (thread detail)

Add a `$effect` that:
1. Opens a thread SSE stream via `openSSE('thread/${threadId}')`
2. Listens for `thread_updated`: merges into `thread` state
3. Listens for `message_created`: appends to `thread.messages` (avoids full reload)
4. Listens for `run_updated`: replaces or inserts the run in `runs` array; if new run, fires `playbooksApi.getRun(run.id)` to get full run details (including playbook name) and inserts into `runDetails`
5. Listens for `step_execution_created`: finds `runDetails[runId]` and appends a new execution with status `running`
6. Listens for `step_execution_updated`: replaces the matching execution in `runDetails[runId].executions`
7. On reconnect: calls `load()` to resync

The existing `$derived` values (`waitingRun`, `activeRuns`) automatically recompute from the live `runs` state, so the manual action banner appears/disappears without any additional code.

---

## Breaking point analysis

### Thread detail page — step execution UX
The current thread detail renders each run's executions in a flat list. With live updates, a `step_execution_created` event will append an execution with `status: 'running'`. The UI already renders a status-coloured dot per execution. A `running` execution will show the in-progress color. When `step_execution_updated` fires, the dot transitions to green/red. No template changes required.

### Inbox — urgency grouping flicker
When a `thread_updated` fires (e.g., run starts → `latest_run_status` changes to `running`), the thread's urgency group may change. Because `grouped` is `$derived.by`, this causes a recomputation. A thread moving from "attention" to "progress" will disappear from one group and appear in another. The existing `fly` transition handles appearance; disappearance is instant. This is intentional and matches the "live messaging vibe" requirement.

### Event bus memory leak risk
If an SSE connection is dropped without `onAbort` firing (e.g., process crash mid-stream), the subscriber remains in the map. Hono's `streamSSE` reliably fires `onAbort` on both clean close and dirty disconnect. Added safety: `subscribe` records creation time; a background sweep every 5 minutes removes subscribers older than 10 minutes that haven't received a ping acknowledgement. (Low priority, add in implementation if time allows.)

### CORS
The existing `cors({ origin: FRONTEND_ORIGIN, credentials: true })` covers all methods and headers for the SSE GET endpoint. No changes needed. The `?token=` query param doesn't affect CORS.

### Missing `workspace_id` on `playbook_runs` events
The executor has access to `run.workspace_id` — this is already on the `playbook_runs` row, so event payloads will always include it for correct workspace scoping.

---

## Files Created/Modified

| File | Action | Reason |
|---|---|---|
| `api/services/event-bus.ts` | Create | In-memory pub/sub singleton |
| `api/db/queries.ts` | Create | Shared denormalized thread fetch query |
| `api/routes/events.ts` | Create | SSE endpoints |
| `api/main.ts` | Modify | Register events router |
| `api/services/gmail.ts` | Modify | Publish thread_created, thread_updated, message_created |
| `api/services/playbook/executor.ts` | Modify | Publish run_updated, step_execution_* |
| `api/routes/threads.ts` | Modify | Publish thread_updated on status/draft changes |
| `frontend/src/lib/sse.ts` | Create | EventSource factory with token auth |
| `frontend/src/routes/+page.svelte` | Modify | Subscribe to workspace events |
| `frontend/src/routes/threads/[id]/+page.svelte` | Modify | Subscribe to thread events |

No database migrations required. All event data is derived from existing tables.

---

## Docs Consulted

| Source | Used for |
|---|---|
| https://hono.dev/docs/helpers/streaming | `streamSSE`, `onAbort`, `stream.sleep` API |
| Svelte MCP — `$effect` section | Teardown functions, dependency tracking, cleanup lifecycle |
| Svelte MCP — Lifecycle hooks section | `onMount`/`onDestroy` vs `$effect` for SSE setup |
| Postgres MCP — schema inspection | Confirmed `workspace_id` on `playbook_runs`, `playbook_step_executions` columns available for event routing |
| MDN EventSource | Auto-reconnect behavior, `Last-Event-ID` header, `open` event on reconnect |
