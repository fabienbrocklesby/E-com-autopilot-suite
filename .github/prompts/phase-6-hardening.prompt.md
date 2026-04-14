---
agent: 'agent'
description: 'Phase 6: production hardening - observability, error recovery, rate limits, monitoring, customer silence timeouts'
tools: ['search/codebase', 'edit', 'runCommands', 'mcp_postgres_query']
---

# Phase 6: Production Hardening

Goal: The engine works and is smart (Phase 5). Now make it survive real production traffic at scale without manual intervention. Add the boring-but-essential stuff: rate limits, retries, timeouts, observability, alerting hooks.

## Required reading

- `docs/PLAYBOOK_ENGINE.md`
- `docs/TASK_LOG.md` — Phase 5 done with all playbooks regenerated and tested

## The 8 hardening tasks

### 1. Customer silence timeout

Problem: a run in `waiting_for_customer` status with no customer reply sits forever. No escalation, no follow-up.

**Schema**: add `customer_silence_hours INT DEFAULT 168` to `playbooks` table (7 days default). Migration `0NN_playbook_timeouts.sql`.

**Worker**: new file `api/services/playbook/timeout_worker.ts`. Runs every 30 minutes via setInterval in `main.ts`:

```ts
// Find runs waiting for customer longer than their playbook's timeout
SELECT r.id, r.thread_id, p.customer_silence_hours
FROM playbook_runs r
JOIN playbooks p ON p.id = r.playbook_id
WHERE r.status = 'waiting_for_customer'
  AND r.updated_at < NOW() - (p.customer_silence_hours || ' hours')::interval;
```

For each: escalate the run with reason "Customer silence timeout after N hours", update thread status to `in_review` so it appears in the review queue.

**Playbook config UI**: add a number input for `customer_silence_hours` on the playbook editor. Default 168 but let the client tune per playbook.

**Validation**: create a test playbook with `customer_silence_hours: 0.01` (36 seconds). Trigger a run that reaches `ask_customer`. Wait a minute. Verify it escalates.

### 2. AI call retries with exponential backoff

Current `chatCompletion` has a single retry on 429. Real production needs more.

**File**: `api/services/ai.ts`

Replace the retry logic with:
- Max 3 retries on 429, 500, 502, 503, 504
- Exponential backoff: 1s, 2s, 4s (honouring `Retry-After` header if present)
- Circuit breaker: if 5 consecutive failures across the whole app in 60 seconds, skip AI calls for 2 minutes and return a graceful fallback

The circuit breaker lives as a module-level state (or cleaner: a single row in a new `system_state` table with a `last_ai_failure_burst TIMESTAMPTZ` column — survives restarts).

When circuit is open:
- `chatCompletion` throws `AppError("AI temporarily unavailable", 503)`
- Step handlers that depend on AI catch this and return `fail` with reason "AI unavailable, will retry"
- Executor marks the step as `failed`, keeps the run in `running` status, schedules a retry (see task 3)

### 3. Retry queue for failed steps

Problem: a step that fails due to transient error (AI down, Gmail API blip, Sheets rate limit) currently marks the run as failed permanently.

**Schema**: add `retry_count INT DEFAULT 0` and `next_retry_at TIMESTAMPTZ` to `playbook_runs`. Migration `0NN_run_retries.sql`.

**Executor**: when a step returns `fail` with a retriable error, instead of escalating:
- Increment retry_count
- Set next_retry_at to NOW() + exponential backoff (5min, 15min, 30min)
- Set status back to `running` (or a new status `retrying`)
- Don't advance the step cursor

Retriable error types: AI temporarily unavailable, Google API 5xx, Google API 429. Everything else still fails immediately.

**Worker**: `retry_worker.ts` runs every 5 minutes:

```ts
SELECT * FROM playbook_runs
WHERE status = 'retrying' AND next_retry_at <= NOW()
  AND retry_count < 5;
```

For each: call `advanceRun(id)` again. If retry_count hits 5, escalate permanently.

### 4. Rate limiting on Gmail + Sheets calls

Problem: a busy workspace can burst hit Gmail's quota. Currently no throttling.

**File**: new `api/services/rate_limit.ts`

Implement a simple token-bucket per workspace, per API (Gmail, Sheets). Store state in Postgres so it survives restarts:

```sql
CREATE TABLE rate_limit_buckets (
  workspace_id INT NOT NULL,
  api TEXT NOT NULL CHECK (api IN ('gmail', 'sheets', 'openai')),
  tokens NUMERIC NOT NULL,
  last_refilled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, api)
);
```

Gmail allows ~250 quota units/second per user. We'll set our per-workspace limit to 50/second to be safe.

Wrap all Gmail and Sheets API calls through a `rateLimitedCall(workspaceId, api, fn)` that:
- Refills the bucket based on time since `last_refilled_at`
- If tokens available: decrement, call fn, return
- If not: await until tokens available (with a max wait of 30s, else throw)

Apply to `gmail.ts` (`gmailGet`, `gmailPost`, `sendReply`) and `google-auth.ts` (for token refresh API call).

### 5. Dead letter queue for emails that fail to ingest

Problem: if `ingestMessage` crashes (malformed email, missing header, AI down), the webhook returns 204 and the message is lost.

**Schema**: new table `failed_ingestions`:

```sql
CREATE TABLE failed_ingestions (
  id SERIAL PRIMARY KEY,
  workspace_id INT NOT NULL,
  gmail_message_id TEXT NOT NULL,
  gmail_thread_id TEXT NOT NULL,
  error TEXT NOT NULL,
  payload JSONB,
  attempt_count INT NOT NULL DEFAULT 1,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_failed_ingestions_unresolved ON failed_ingestions(workspace_id) WHERE NOT resolved;
```

**Code change**: wrap `ingestMessage` in try/catch. On failure: insert into `failed_ingestions`, log, continue. Don't crash the webhook handler.

**Retry worker**: same `retry_worker.ts` also handles this — every 5 minutes, retry unresolved failed ingestions up to 3 times. After 3 attempts, mark `resolved=true` with error "Gave up after 3 attempts" and alert (see task 8).

**UI**: add a `/system/failed-ingestions` admin page showing unresolved failures with a retry button. Simple table, nothing fancy.

### 6. Structured logging

Current logging is `console.log` with strings. Hard to grep, hard to ship to a log aggregator later.

**File**: new `api/services/logger.ts`

```ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function log(level: LogLevel, event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data,
  }));
}

export const logger = {
  debug: (event: string, data?: Record<string, unknown>) => log('debug', event, data),
  info: (event: string, data?: Record<string, unknown>) => log('info', event, data),
  warn: (event: string, data?: Record<string, unknown>) => log('warn', event, data),
  error: (event: string, data?: Record<string, unknown>) => log('error', event, data),
};
```

Replace all `console.log` calls across the backend with `logger.info/warn/error`. Every log line becomes one JSON object with consistent fields (`workspace_id`, `thread_id`, `run_id` where applicable).

Critical events to log:
- Run created / advanced / paused / completed / escalated
- Step executed (with duration)
- AI call (model, tokens, duration)
- Gmail API call (endpoint, status, duration)
- Sheets API call
- Webhook received
- Rate limit hit
- Retry scheduled
- Circuit breaker opened/closed
- Failed ingestion

### 7. Observability dashboard

**Frontend**: new page `/system/+page.svelte`

Simple dashboard showing:
- Active runs count (by status)
- Runs escalated in last 24h
- Average step execution time (last 1h, 24h)
- AI calls in last 24h (count, total tokens)
- Failed ingestions (count, last error)
- Circuit breaker state
- Gmail API calls in last 1h
- Sheets API calls in last 1h

All backed by SQL queries on the tables we already have (`playbook_runs`, `playbook_step_executions`, `failed_ingestions`). No fancy metrics system yet, just live DB reads with a 30s client-side refresh.

**Backend**: new route `api/routes/system.ts` with endpoints:
- `GET /system/stats` — returns the dashboard data
- `GET /system/circuit-breaker` — returns circuit breaker state
- `POST /system/circuit-breaker/reset` — manual reset (for when you know the downstream is back)

### 8. Alerting hook

Minimal: a single webhook URL in settings. When these events happen, POST to the webhook:

- Run escalated
- Ingestion failed permanently (3 attempts exceeded)
- Circuit breaker opened
- Rate limit hit sustained (>5 waits in 60s)

**Schema**: add to `settings` table entries for `alert_webhook_url` and `alert_events` (JSONB array of event names to send).

**Code**: `api/services/alerts.ts` with `sendAlert(workspaceId, event, data)`. Fetches settings, checks event is enabled, POSTs JSON.

Fabien can point this at a Slack webhook, Discord webhook, or his own endpoint. Don't build a full alerting system, just the hook.

## Workflow

1. Confirm Phase 5 done
2. Ship in order: 1 (timeouts) → 2 (AI retries) → 3 (retry queue) → 4 (rate limits) → 5 (DLQ) → 6 (logging) → 7 (dashboard) → 8 (alerts)
3. Each is a separate commit or PR
4. Update TASK_LOG after each
5. After all done: run load test (simulate 100 emails over 10 minutes against dev) and verify nothing falls over

## Done criteria

- [ ] Customer silence timeout escalates stuck runs after configured duration
- [ ] AI calls retry with backoff; circuit breaker opens under sustained failure
- [ ] Failed steps retry up to 5 times before permanent failure
- [ ] Gmail + Sheets calls rate-limited per workspace
- [ ] Failed ingestions captured in DLQ, retry worker processes them
- [ ] Structured JSON logging across the backend
- [ ] `/system` dashboard shows live stats
- [ ] Alert webhook fires for critical events
- [ ] Load test: 100 emails in 10 minutes → no crashes, no lost messages, no runaway runs
- [ ] TASK_LOG updated

## What NOT to do in this phase

- Don't introduce Redis, RabbitMQ, or other infra
- Don't build a full observability stack (Datadog, Grafana, etc)
- Don't add metrics libraries
- The goal is "won't fall over", not "industrial-grade monitoring"
