-- Phase 6: Dead letter queue for failed ingestions + alert settings

CREATE TABLE IF NOT EXISTS failed_ingestions (
  id               SERIAL      PRIMARY KEY,
  workspace_id     INT         NOT NULL,
  gmail_message_id TEXT        NOT NULL,
  gmail_thread_id  TEXT        NOT NULL,
  error            TEXT        NOT NULL,
  payload          JSONB,
  attempt_count    INT         NOT NULL DEFAULT 1,
  last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved         BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique on (workspace, message) so duplicate webhook deliveries don't create duplicate rows
CREATE UNIQUE INDEX IF NOT EXISTS idx_failed_ingestions_unique
  ON failed_ingestions(workspace_id, gmail_message_id)
  WHERE NOT resolved;

CREATE INDEX IF NOT EXISTS idx_failed_ingestions_unresolved
  ON failed_ingestions(workspace_id)
  WHERE NOT resolved;

-- Seed alert settings (these are optional — empty value means disabled)
INSERT INTO settings (workspace_id, key, value)
VALUES
  (1, 'alert_webhook_url', ''),
  (1, 'alert_events', '["run_escalated","ingestion_failed_permanently","circuit_breaker_opened","rate_limit_sustained"]')
ON CONFLICT (workspace_id, key) DO NOTHING;
