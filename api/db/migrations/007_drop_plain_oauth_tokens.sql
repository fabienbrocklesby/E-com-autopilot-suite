-- Migration 007: Drop plaintext OAuth token columns.
-- These columns were already absent in this DB before this migration was tracked.
-- The IF EXISTS guards make this safe to apply on any state.

ALTER TABLE oauth_tokens
  DROP COLUMN IF EXISTS access_token,
  DROP COLUMN IF EXISTS refresh_token;
