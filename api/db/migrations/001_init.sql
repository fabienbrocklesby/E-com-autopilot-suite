-- Migration: 001_init
-- Creates all baseline tables for the email automation dashboard.

-- ─── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Migration tracking ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── categories ───────────────────────────────────────────────────────────────
CREATE TABLE categories (
  id                   SERIAL PRIMARY KEY,
  name                 TEXT        NOT NULL UNIQUE,
  description          TEXT        NOT NULL DEFAULT '',
  instructions         TEXT        NOT NULL DEFAULT '',
  allow_auto_reply     BOOLEAN     NOT NULL DEFAULT FALSE,
  confidence_threshold NUMERIC(4,3) NOT NULL DEFAULT 0.800
                         CHECK (confidence_threshold BETWEEN 0 AND 1),
  writing_style        TEXT        NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── threads ──────────────────────────────────────────────────────────────────
CREATE TABLE threads (
  id               SERIAL PRIMARY KEY,
  gmail_thread_id  TEXT        NOT NULL UNIQUE,
  subject          TEXT        NOT NULL DEFAULT '',
  snippet          TEXT        NOT NULL DEFAULT '',
  category_id      INTEGER     REFERENCES categories(id) ON DELETE SET NULL,
  status           TEXT        NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new', 'in_review', 'replied', 'ignored', 'closed')),
  auto_replied     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_threads_category_id  ON threads(category_id);
CREATE INDEX idx_threads_status       ON threads(status);
CREATE INDEX idx_threads_created_at   ON threads(created_at DESC);

-- ─── messages ─────────────────────────────────────────────────────────────────
CREATE TABLE messages (
  id               SERIAL PRIMARY KEY,
  thread_id        INTEGER     NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  gmail_message_id TEXT        NOT NULL UNIQUE,
  from_address     TEXT        NOT NULL,
  body_plain       TEXT        NOT NULL DEFAULT '',
  body_html        TEXT        NOT NULL DEFAULT '',
  received_at      TIMESTAMPTZ NOT NULL,
  direction        TEXT        NOT NULL CHECK (direction IN ('inbound', 'outbound'))
);

CREATE INDEX idx_messages_thread_id   ON messages(thread_id);
CREATE INDEX idx_messages_received_at ON messages(received_at DESC);

-- ─── drafts ───────────────────────────────────────────────────────────────────
CREATE TABLE drafts (
  id         SERIAL PRIMARY KEY,
  thread_id  INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected', 'sent')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_drafts_thread_id ON drafts(thread_id);
CREATE INDEX idx_drafts_status    ON drafts(status);

-- ─── settings ─────────────────────────────────────────────────────────────────
CREATE TABLE settings (
  id         SERIAL PRIMARY KEY,
  key        TEXT        NOT NULL UNIQUE,
  value      TEXT        NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed with sensible defaults
INSERT INTO settings (key, value) VALUES
  ('default_confidence_threshold', '0.8'),
  ('auto_reply_enabled',           'false'),
  ('gmail_watch_expiry',           ''),
  ('openai_model',                 'gpt-4o')
ON CONFLICT (key) DO NOTHING;

-- ─── oauth_tokens ─────────────────────────────────────────────────────────────
CREATE TABLE oauth_tokens (
  id            SERIAL PRIMARY KEY,
  email         TEXT        NOT NULL UNIQUE,
  access_token  TEXT        NOT NULL,
  refresh_token TEXT        NOT NULL,
  expiry        TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── updated_at auto-update function ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_categories_updated_at
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_threads_updated_at
  BEFORE UPDATE ON threads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_drafts_updated_at
  BEFORE UPDATE ON drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_settings_updated_at
  BEFORE UPDATE ON settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_oauth_tokens_updated_at
  BEFORE UPDATE ON oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
