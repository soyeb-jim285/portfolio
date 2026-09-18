import type { Pool } from 'pg';
import type { Embedder } from './embeddings';
import { toVectorLiteral } from './embeddings';
import knowledge from './knowledge.json' with { type: 'json' };
import { sourceUrl } from './repos';

export const MAX_SNIPPET_CHARS = 1500;
export const MAX_READ_LINES = 200;
export const MAX_READ_CHARS = 8000;
const CANDIDATES = 20;
const RRF_K = 60;
// Which repository a match came from is evidence about relevance, not about truth: a featured,
// starred or recently touched project outranks an old scratch repo when both match equally well.
// It only reorders real matches, and an explicit repo filter makes it moot.
const FEATURED = (knowledge.featuredRepos as string[]).map(name => name.toLowerCase());

export type SourceHit = {
  repo: string; path: string; language: string; symbols: string[];
  startLine: number; endLine: number; commit: string; url: string; snippet: string;
};
export type IndexedRepo = { repo: string; commit: string; files: number; chunks: number; indexedAt: string; blurb: string; stars: number; language: string; pushedAt: string };

const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit)}\n… truncated`);
// Repository names arrive from a model or a URL, so they are normalised before they reach a query.
// Names are compared lowercased on both sides: GitHub names keep their case (LeakNet), the model's may not.
const key = (repo: string) => repo.toLowerCase().trim();

export function createRetrieval(pool: Pool, embedder: Embedder) {
  // One stored file of the live revision, or nothing: an unindexed path has no row to return.
  const indexedFile = async (repo: string, path: string) => {
    const name = key(repo);
    const { rows } = await pool.query<{ repo: string; commit_sha: string; line_count: number; content: string; language: string; url: string }>(
      `SELECT r.repo, r.commit_sha, f.line_count, f.content, f.language, coalesce(rf.url, '') AS url
       FROM source_files f
       JOIN index_revisions r ON r.id = f.revision_id
       LEFT JOIN repo_facts rf ON rf.repo = r.repo
       WHERE r.status = 'live' AND r.embedding_dims = $3 AND lower(r.repo) = $1 AND f.path = $2`, [name, path, embedder.dims]);
    return rows[0] ?? null;
  };

  return {
    async indexedRepos(): Promise<IndexedRepo[]> {
      const { rows } = await pool.query(
        `SELECT r.repo, r.commit_sha, r.file_count, r.chunk_count, r.promoted_at,
                coalesce(f.description, '') AS description, coalesce(f.stars, 0) AS stars,
                coalesce(f.language, '') AS language, f.pushed_at
         FROM index_revisions r LEFT JOIN repo_facts f ON f.repo = r.repo
         WHERE r.status = 'live' AND r.embedding_dims = $1
         ORDER BY coalesce(f.stars, 0) DESC, f.pushed_at DESC NULLS LAST, r.repo`, [embedder.dims]);
      return rows.map(row => ({
        repo: row.repo, commit: row.commit_sha, files: row.file_count, chunks: row.chunk_count,
        indexedAt: row.promoted_at?.toISOString() ?? '', blurb: row.description, stars: row.stars,
        language: row.language, pushedAt: row.pushed_at?.toISOString() ?? '',
      }));
    },

    // Hybrid: lexical for exact identifiers, vector for described behaviour, fused with reciprocal rank.
    async search(query: string, options: { repo?: string; limit?: number } = {}): Promise<SourceHit[]> {
      const limit = Math.min(Math.max(options.limit ?? 6, 1), 10);
      const repo = options.repo ? key(options.repo) : null;
      const [vector] = await embedder.embed([query]);
      const { rows } = await pool.query(
        `WITH live AS (
           SELECT r.id, r.repo, r.commit_sha, coalesce(f.url, '') AS url,
                  1.0
                  + CASE WHEN lower(r.repo) = ANY($8::text[]) THEN 0.6 ELSE 0 END
                  + CASE WHEN coalesce(f.stars, 0) >= 50 THEN 0.5 WHEN coalesce(f.stars, 0) >= 5 THEN 0.25 ELSE 0 END
                  + CASE WHEN f.pushed_at > now() - interval '180 days' THEN 0.3
                         WHEN f.pushed_at > now() - interval '730 days' THEN 0.1 ELSE 0 END AS weight
           FROM index_revisions r LEFT JOIN repo_facts f ON f.repo = r.repo
           WHERE r.status = 'live' AND r.embedding_dims = $3 AND ($2::text IS NULL OR lower(r.repo) = $2)
         ),
         matched AS (
           SELECT c.id, ts_rank_cd(c.search, tsq.query) AS score
           FROM source_chunks c JOIN live ON live.id = c.revision_id,
                LATERAL (SELECT websearch_to_tsquery('english', $1) AS query UNION ALL SELECT websearch_to_tsquery('simple', $1)) tsq
           WHERE c.search @@ tsq.query
         ),
         lexical AS (
           SELECT id, row_number() OVER (ORDER BY max(score) DESC, id) AS rank
           FROM matched GROUP BY id ORDER BY max(score) DESC LIMIT $4
         ),
         semantic AS (
           SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> $5::vector, c.id) AS rank
           FROM source_chunks c JOIN live ON live.id = c.revision_id
           WHERE c.embedding IS NOT NULL ORDER BY c.embedding <=> $5::vector LIMIT $4
         ),
         fused AS (
           SELECT id, sum(weight) AS score FROM (
             SELECT id, 1.0 / ($6 + rank) AS weight FROM lexical
             UNION ALL SELECT id, 1.0 / ($6 + rank) AS weight FROM semantic
           ) scores GROUP BY id
         ),
         ranked AS (
           SELECT live.repo, live.commit_sha, live.url, c.path, c.language, c.symbols, c.start_line, c.end_line, c.content,
                  fused.score * live.weight AS score,
                  row_number() OVER (PARTITION BY live.repo, c.path ORDER BY fused.score DESC, c.start_line) AS per_file
           FROM fused JOIN source_chunks c ON c.id = fused.id JOIN live ON live.id = c.revision_id
         )
         -- At most two windows per file: one long document must not fill every result slot.
         SELECT repo, commit_sha, url, path, language, symbols, start_line, end_line, content
         FROM ranked WHERE per_file <= 2 ORDER BY score DESC, path, start_line LIMIT $7`,
        [query, repo, embedder.dims, CANDIDATES, toVectorLiteral(vector), RRF_K, limit, FEATURED]);
      return rows.map(row => ({
        repo: row.repo, path: row.path, language: row.language, symbols: row.symbols,
        startLine: row.start_line, endLine: row.end_line, commit: row.commit_sha,
        url: row.url ? sourceUrl({ url: row.url }, row.commit_sha, row.path, row.start_line, row.end_line) : '',
        snippet: clip(row.content, MAX_SNIPPET_CHARS),
      }));
    },

    // Bounded window of a real indexed file: the model can never quote a path that is not here.
    async read(repo: string, path: string, startLine = 1, endLine?: number) {
      const file = await indexedFile(repo, path);
      if (!file) return null;
      const lines = file.content.split('\n');
      const from = Math.min(Math.max(Math.trunc(startLine) || 1, 1), lines.length);
      const to = Math.min(Math.max(Math.trunc(endLine ?? from + MAX_READ_LINES - 1), from), lines.length, from + MAX_READ_LINES - 1);
      return {
        repo: file.repo, path, language: file.language, commit: file.commit_sha,
        startLine: from, endLine: to, lineCount: file.line_count,
        url: file.url ? sourceUrl({ url: file.url }, file.commit_sha, path, from, to) : '',
        content: clip(lines.slice(from - 1, to).join('\n'), MAX_READ_CHARS),
      };
    },

    async listFiles(repo: string, limit = 200) {
      const name = key(repo);
      const { rows } = await pool.query(
        `SELECT f.path, f.line_count FROM source_files f JOIN index_revisions r ON r.id = f.revision_id
         WHERE r.status = 'live' AND r.embedding_dims = $3 AND lower(r.repo) = $1 ORDER BY f.path LIMIT $2`, [name, limit, embedder.dims]);
      return rows.map(row => ({ path: row.path, lines: row.line_count }));
    },
  };
}

export type Retrieval = ReturnType<typeof createRetrieval>;
