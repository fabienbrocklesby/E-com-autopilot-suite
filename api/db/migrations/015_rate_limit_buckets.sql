-- Phase 6: Rate limit token buckets

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  workspace_id    INT            NOT NULL,
  api             TEXT           NOT NULL CHECK (api IN ('gmail', 'sheets', 'openai')),
  tokens          NUMERIC        NOT NULL,
  last_refilled_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  calls_total     BIGINT         NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, api)
);
