-- Idempotent DDL, applied at boot. Swap for a migration tool once columns start changing.
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

-- Conversations live in the visitor's browser and are never stored here. Earlier deployments kept
-- them in a messages table; dropping it erases every stored transcript.
DROP TABLE IF EXISTS messages;

-- Finished answers, replayed when the full model context matches. The key hashes the model,
-- system prompt, indexed commits, time zone and turns; an answer may quote the question text.
CREATE TABLE IF NOT EXISTS answer_cache (
  key bytea PRIMARY KEY,
  events jsonb NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS answer_cache_expires_idx ON answer_cache (expires_at);

-- Shared fixed-window counters; keys are hashes, not stored client addresses.
CREATE TABLE IF NOT EXISTS rate_limits (
  key bytea PRIMARY KEY,
  count integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_expiry_idx ON rate_limits (expires_at);

-- Request budget that survives restarts and is shared by every process on this database.
CREATE TABLE IF NOT EXISTS usage_daily (
  day date PRIMARY KEY,
  requests integer NOT NULL DEFAULT 0
);
