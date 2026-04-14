-- Phase 6: Customer silence timeout + system state table

-- Add customer_silence_hours to playbooks (7 day default = 168 hours)
ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS customer_silence_hours INT NOT NULL DEFAULT 168;

-- System state table for circuit breaker and other persistent app state
CREATE TABLE IF NOT EXISTS system_state (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION set_system_state_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_system_state_updated_at
  BEFORE UPDATE ON system_state
  FOR EACH ROW EXECUTE FUNCTION set_system_state_updated_at();
