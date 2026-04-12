-- Migration: 004_fixes
-- Remove the global auto_reply_enabled setting. Auto-reply is controlled per
-- category only (categories.allow_auto_reply + categories.confidence_threshold).
-- No per-category data is touched.
DELETE FROM settings WHERE key = 'auto_reply_enabled';
