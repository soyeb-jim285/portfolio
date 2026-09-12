-- Idempotent DDL, applied at boot. Swap for a migration tool once columns start changing.
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

-- Messages die with their session, so deleting the session is a complete erasure.
CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session_id, id);

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

ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

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

-- Parsed dependency edges, scoped to the revision they were read from.
CREATE TABLE IF NOT EXISTS source_edges (
  revision_id bigint NOT NULL REFERENCES index_revisions (id) ON DELETE CASCADE,
  from_path text NOT NULL,
  to_path text NOT NULL,
  kind text NOT NULL,
  PRIMARY KEY (revision_id, from_path, to_path)
);
