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

-- Phase 11: where an answer's time goes. Per model step: time to its first streamed chunk and its
-- duration; per answer: prompt tokens the provider served from its cache, and hidden reasoning tokens.
ALTER TABLE answer_metrics ADD COLUMN IF NOT EXISTS cached_prompt_tokens integer;
ALTER TABLE answer_metrics ADD COLUMN IF NOT EXISTS reasoning_tokens integer;
ALTER TABLE answer_metrics ADD COLUMN IF NOT EXISTS step_first_ms integer[] NOT NULL DEFAULT '{}';
ALTER TABLE answer_metrics ADD COLUMN IF NOT EXISTS step_ms integer[] NOT NULL DEFAULT '{}';
-- Eval runs and cache warm-ups are labelled so they never pass for visitors in the stats.
ALTER TABLE answer_metrics ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'visitor';
