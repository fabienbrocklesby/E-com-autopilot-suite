-- Migration 008: Create oauth_states table for CSRF protection on the OAuth callback.
-- State entries expire after 10 minutes (enforced at application level).
-- Old entries are cleaned up by the callback handler on use (DELETE after verify).

CREATE TABLE oauth_states (
  state      TEXT        NOT NULL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast expiry lookups.
CREATE INDEX oauth_states_created_at_idx ON oauth_states (created_at);
