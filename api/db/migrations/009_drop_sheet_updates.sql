-- Migration 009: Drop the sheet_updates table.
-- This table received no writes (dead code — applyUpdates was never called in production).
-- All sheet writes now go through writeToSheet in sheet-rules.ts directly.

DROP TABLE IF EXISTS sheet_updates;
