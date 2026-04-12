-- Migration 003: store the RFC 2822 Message-ID header from inbound emails.
-- This is needed to build correct In-Reply-To / References headers when
-- auto-sending replies, so Gmail threads them with the original email.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_id_header TEXT;
