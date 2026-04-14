/**
 * Token-bucket rate limiter backed by Postgres.
 * Survives restarts because state is stored in rate_limit_buckets.
 */
import { queryOne, execute } from "../db/client.ts";
import { AppError } from "../types/index.ts";
import { logger } from "./logger.ts";

// Tokens per second per API
const BUCKET_CONFIGS = {
  gmail:  { capacity: 50,  refill_per_sec: 50  }, // 50/sec
  sheets: { capacity: 100, refill_per_sec: 2   }, // ~100/min to be safe
  openai: { capacity: 60,  refill_per_sec: 1   }, // 60/min
} as const;

export type ApiName = keyof typeof BUCKET_CONFIGS;

// Track recent rate-limit waits for sustained alerting
const recentWaits: Map<string, number[]> = new Map();

export function recordRateLimitWait(workspaceId: number, api: ApiName): void {
  const key = `${workspaceId}:${api}`;
  const now = Date.now();
  const times = recentWaits.get(key) ?? [];
  const cutoff = now - 60_000;
  const filtered = times.filter((t) => t > cutoff);
  filtered.push(now);
  recentWaits.set(key, filtered);
}

export function getRateLimitWaitCount(workspaceId: number, api: ApiName): number {
  const key = `${workspaceId}:${api}`;
  const now = Date.now();
  const times = recentWaits.get(key) ?? [];
  return times.filter((t) => t > now - 60_000).length;
}

/**
 * Wrap an async call with rate limiting for the given workspace and API.
 * Blocks (with polling) up to maxWaitMs then throws 429.
 */
export async function rateLimitedCall<T>(
  workspaceId: number,
  api: ApiName,
  fn: () => Promise<T>,
  maxWaitMs = 30_000,
): Promise<T> {
  const cfg = BUCKET_CONFIGS[api];
  const startedAt = Date.now();

  // Ensure bucket exists
  await execute(
    `INSERT INTO rate_limit_buckets (workspace_id, api, tokens, last_refilled_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (workspace_id, api) DO NOTHING`,
    [workspaceId, api, cfg.capacity],
  );

  let waited = false;

  while (true) {
    // Refill and consume atomically. The LEAST caps at capacity; GREATEST prevents negatives.
    // WHERE filters out starved buckets so the UPDATE only fires when a token is available.
    const row = await queryOne<{ tokens: number }>(
      `UPDATE rate_limit_buckets
       SET
         tokens = GREATEST(0,
           LEAST($3::numeric,
             tokens + ($4::numeric * EXTRACT(EPOCH FROM (NOW() - last_refilled_at)))
           )
         ) - 1,
         last_refilled_at = NOW(),
         calls_total = calls_total + 1
       WHERE workspace_id = $1 AND api = $2
         AND GREATEST(0,
               LEAST($3::numeric,
                 tokens + ($4::numeric * EXTRACT(EPOCH FROM (NOW() - last_refilled_at)))
               )
             ) >= 1
       RETURNING tokens`,
      [workspaceId, api, cfg.capacity, cfg.refill_per_sec],
    );

    if (row) {
      if (waited) {
        logger.debug("rate_limit.wait_ended", { workspace_id: workspaceId, api });
      }
      return fn();
    }

    // Bucket empty — wait
    const elapsed = Date.now() - startedAt;
    if (elapsed >= maxWaitMs) {
      logger.warn("rate_limit.exceeded", { workspace_id: workspaceId, api, waited_ms: elapsed });
      throw new AppError(429, `Rate limit exceeded for ${api}`);
    }

    if (!waited) {
      waited = true;
      recordRateLimitWait(workspaceId, api);
      logger.warn("rate_limit.waiting", { workspace_id: workspaceId, api });
    }

    // Sleep until a token should be available
    const waitMs = Math.min(Math.ceil(1000 / cfg.refill_per_sec), maxWaitMs - elapsed);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
