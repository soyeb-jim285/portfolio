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
