-- Migration 006: Add encrypted token columns to oauth_tokens.
-- Note: migration 007 (drop plaintext columns) was already applied to this DB.
-- This migration is a no-op if columns already exist.

ALTER TABLE oauth_tokens
  ADD COLUMN IF NOT EXISTS access_token_encrypted  BYTEA,
  ADD COLUMN IF NOT EXISTS refresh_token_encrypted BYTEA;
