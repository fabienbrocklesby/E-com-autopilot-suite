-- 028_thread_brief_and_streaks.sql
-- Why this exists: AI reply/evaluate/triage prompts only see the last few
-- messages even though the full thread is loaded, and a second run on the
-- same thread (recategorised, or the customer returns weeks later) starts
-- from an empty context bag, silently losing everything an earlier run
-- learned. threads.brief gives every run a durable, thread-scoped memory
-- (extracted facts plus a lazily regenerated summary) that startRun seeds
-- new runs from. The two playbooks columns support the per-category
-- auto-send trust ramp (a later phase): count consecutive clean approvals
-- and compare against a target before flipping reply_mode.
-- Touches tables: threads, playbooks
-- Destructive: no

BEGIN;

ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS brief JSONB NOT NULL DEFAULT '{}';

ALTER TABLE playbooks
  ADD COLUMN IF NOT EXISTS auto_send_streak_target INT NOT NULL DEFAULT 10
    CHECK (auto_send_streak_target > 0),
  ADD COLUMN IF NOT EXISTS approval_streak INT NOT NULL DEFAULT 0
    CHECK (approval_streak >= 0);

COMMIT;
