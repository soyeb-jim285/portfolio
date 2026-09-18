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

-- Phase 2: code retrieval.
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per indexing run. Exactly one revision per repository is live at a time.
CREATE TABLE IF NOT EXISTS index_revisions (
  id bigserial PRIMARY KEY,
  repo text NOT NULL,
  commit_sha text NOT NULL,
  embedding_model text NOT NULL,
  embedding_dims integer NOT NULL,
  status text NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'live')),
  file_count integer NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS index_revisions_live_idx ON index_revisions (repo) WHERE status = 'live';

-- Whole files back read_source; deleting the revision deletes everything indexed from it.
CREATE TABLE IF NOT EXISTS source_files (
  id bigserial PRIMARY KEY,
  revision_id bigint NOT NULL REFERENCES index_revisions (id) ON DELETE CASCADE,
  path text NOT NULL,
  language text NOT NULL,
  line_count integer NOT NULL,
  content text NOT NULL,
  content_hash bytea NOT NULL,
  UNIQUE (revision_id, path)
);

CREATE TABLE IF NOT EXISTS source_chunks (
  id bigserial PRIMARY KEY,
  revision_id bigint NOT NULL REFERENCES index_revisions (id) ON DELETE CASCADE,
  path text NOT NULL,
  language text NOT NULL,
  symbols text[] NOT NULL DEFAULT '{}',
  -- Flattened copy of `symbols`: array_to_string is only STABLE, so it cannot be used in a generated column.
  symbol_text text NOT NULL DEFAULT '',
  start_line integer NOT NULL,
  end_line integer NOT NULL,
  content text NOT NULL,
  content_hash bytea NOT NULL,
  -- Unconstrained vector, scanned exactly. A few thousand rows do not need HNSW,
  -- and leaving the dimension open lets a model change be a reindex instead of a migration.
  embedding vector,
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', translate(path, '/_.-', '    ')), 'A') ||
    setweight(to_tsvector('simple', symbol_text), 'A') ||
    setweight(to_tsvector('english', content), 'C')
  ) STORED
);
CREATE INDEX IF NOT EXISTS source_chunks_search_idx ON source_chunks USING gin (search);
CREATE INDEX IF NOT EXISTS source_chunks_revision_idx ON source_chunks (revision_id);

-- Phase 3: UI actions the assistant requested, and what the browser reported back.
CREATE TABLE IF NOT EXISTS ui_actions (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  target text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'done', 'missing', 'failed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);
CREATE INDEX IF NOT EXISTS ui_actions_session_idx ON ui_actions (session_id);

-- Phase 4: contact drafts. A draft is only ever sent by the visitor, never by the model.
CREATE TABLE IF NOT EXISTS contact_drafts (
  id uuid PRIMARY KEY,
  session_id uuid REFERENCES sessions (id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  message text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'failed')),
  provider_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS contact_drafts_expiry_idx ON contact_drafts (expires_at) WHERE status = 'draft';
ALTER TABLE contact_drafts DROP CONSTRAINT IF EXISTS contact_drafts_status_check;
ALTER TABLE contact_drafts ADD CONSTRAINT contact_drafts_status_check CHECK (status IN ('draft', 'sending', 'sent', 'failed', 'unknown'));

ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS contact_sends integer NOT NULL DEFAULT 0;

-- Phase 5: generated artifacts. The bytes live in object storage; this row is the permission check.
CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  object_key text NOT NULL,
  bytes integer NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_expiry_idx ON artifacts (expires_at);

-- Phase 6: proposed calls. Only the visitor confirms one, and only after live availability agrees.
CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  slot_start timestamptz NOT NULL,
  name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  time_zone text NOT NULL DEFAULT 'UTC',
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'conflict', 'failed', 'unknown')),
  provider_uid text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz
);
CREATE INDEX IF NOT EXISTS bookings_expiry_idx ON bookings (expires_at) WHERE status = 'pending';
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN ('pending', 'confirming', 'confirmed', 'conflict', 'failed', 'unknown'));

ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS bookings integer NOT NULL DEFAULT 0;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS event_type_id integer NOT NULL DEFAULT 0;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS meeting_key text NOT NULL DEFAULT '';

-- Phase 8: repositories are discovered from GitHub, so their facts live in the database too.
CREATE TABLE IF NOT EXISTS repo_facts (
  repo text PRIMARY KEY,
  owner text NOT NULL,
  url text NOT NULL,
  branch text NOT NULL,
  description text NOT NULL DEFAULT '',
  language text NOT NULL DEFAULT '',
  topics text[] NOT NULL DEFAULT '{}',
  stars integer NOT NULL DEFAULT 0,
  open_issues integer NOT NULL DEFAULT 0,
  pushed_at timestamptz,
  indexed_commit text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dependency edges once fed the repository explorer, which is gone.
DROP TABLE IF EXISTS source_edges;

-- Phase 9: how each answer performed, never what it said. No session, no address, no text:
-- timings, token counts and cost as the provider reported them, which tools ran, and how it ended.
CREATE TABLE IF NOT EXISTS answer_metrics (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('chat', 'transcribe')),
  cached boolean NOT NULL DEFAULT false,
  outcome text NOT NULL CHECK (outcome IN ('complete', 'truncated', 'error', 'timeout', 'aborted')),
  total_ms integer NOT NULL,
  first_token_ms integer,
  model text NOT NULL DEFAULT '',
  prompt_tokens integer,
  completion_tokens integer,
  cost_usd numeric(12, 8),
  steps integer NOT NULL DEFAULT 0,
  tools text[] NOT NULL DEFAULT '{}',
  tool_ms integer NOT NULL DEFAULT 0,
  sources integer NOT NULL DEFAULT 0,
  audio_seconds numeric(8, 2)
);
CREATE INDEX IF NOT EXISTS answer_metrics_created_idx ON answer_metrics (created_at);

-- Phase 10: search that works for questions, not just identifiers.
-- search_v2 splits camelCase (DrawingCanvas -> drawing canvas) and stems path, symbols and content
-- with the English dictionary, so "draws" meets DrawingCanvas; the 'simple' copies keep exact
-- identifiers (qtconcurrent) findable too. The original `search` column stays for comparison.
ALTER TABLE source_chunks ADD COLUMN IF NOT EXISTS search_v2 tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', regexp_replace(translate(path, '/_.-', '    '), '([a-z0-9])([A-Z])', '\1 \2', 'g')), 'A') ||
  setweight(to_tsvector('english', regexp_replace(symbol_text, '([a-z0-9])([A-Z])', '\1 \2', 'g')), 'A') ||
  setweight(to_tsvector('simple', symbol_text), 'A') ||
  setweight(to_tsvector('english', regexp_replace(content, '([a-z0-9])([A-Z])', '\1 \2', 'g')), 'C') ||
  setweight(to_tsvector('simple', content), 'D')
) STORED;
CREATE INDEX IF NOT EXISTS source_chunks_search_v2_idx ON source_chunks USING gin (search_v2);

-- A one-sentence description of each file, written by a small model at index time, so a question in
-- plain words can find code whose identifiers share none of them. Reused across revisions by content hash.
ALTER TABLE source_files ADD COLUMN IF NOT EXISTS summary text;
ALTER TABLE source_files ADD COLUMN IF NOT EXISTS summary_model text;
ALTER TABLE source_files ADD COLUMN IF NOT EXISTS summary_embedding vector;
ALTER TABLE source_files ADD COLUMN IF NOT EXISTS summary_search tsvector GENERATED ALWAYS AS (
  to_tsvector('english', coalesce(summary, ''))
) STORED;
CREATE INDEX IF NOT EXISTS source_files_summary_search_idx ON source_files USING gin (summary_search);
CREATE INDEX IF NOT EXISTS source_files_revision_idx ON source_files (revision_id);
