import type { Pool } from 'pg';
import type { Embedder } from './embeddings';
import { toVectorLiteral } from './embeddings';
import type { Reranker } from './rerank';
import knowledge from './knowledge.json' with { type: 'json' };
import { sourceUrl } from './repos';

export const MAX_SNIPPET_CHARS = 1500;
// The two best hits carry their whole window: a clipped snippet sent the model back for a
// read_source round trip just to see the line it was about to cite.
export const MAX_TOP_SNIPPET_CHARS = 4000;
const FULL_WINDOW_HITS = 2;
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

/**
 * How a search is assembled. Each switch is one of the measured improvements, so the evaluation can
 * turn them on one at a time; production uses DEFAULT_VARIANT.
 * - lexical 'and' needs every word of the question in one chunk (only bare identifiers ever matched);
 *   'or' ranks chunks by how many words they contain and where (path and symbols count most).
 * - identifiers: search the camelCase-split, stemmed column, so "draws" meets DrawingCanvas.
 * - weighting 'strong' multiplied scores by up to 2.4 for featured, starred, fresh repositories, which
 *   let any chunk of HyprFM outrank the best chunk elsewhere; 'gentle' only breaks near-ties.
 * - summaries: also rank files by their one-sentence description, in words and in meaning.
 * - rerank: a small model reorders the top candidates after reading them.
 */
export type SearchVariant = {
  lexical: 'and' | 'or'; identifiers: boolean; weighting: 'strong' | 'gentle'; summaries: boolean; rerank: boolean;
};
export const BASELINE_VARIANT: SearchVariant = { lexical: 'and', identifiers: false, weighting: 'strong', summaries: false, rerank: false };
export const DEFAULT_VARIANT: SearchVariant = { lexical: 'or', identifiers: true, weighting: 'gentle', summaries: true, rerank: false };
const RERANK_POOL = 20;

// Words of the question for an OR query: letters and digits only, so nothing in a question can
// change the query's syntax. camelCase words are split and also kept whole for exact identifiers.
export function queryTerms(query: string) {
  const words = query.match(/[A-Za-z][A-Za-z0-9]*|[0-9]+/g) ?? [];
  const lower = (list: string[]) => [...new Set(list.map(word => word.toLowerCase()).filter(word => word.length >= 2))].slice(0, 32);
  return {
    split: lower(words.flatMap(word => word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' '))).join(' | '),
    whole: lower(words).join(' | '),
  };
}

export function createRetrieval(pool: Pool, embedder: Embedder, options: { reranker?: Reranker } = {}) {
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

    // Hybrid: lexical for words and identifiers, vector for described behaviour, fused with reciprocal
    // rank. The switches in `variant` are the measured improvements; see SearchVariant.
    async search(query: string, searchOptions: { repo?: string; limit?: number; variant?: Partial<SearchVariant> } = {}): Promise<SourceHit[]> {
      const variant = { ...DEFAULT_VARIANT, ...searchOptions.variant };
      const limit = Math.min(Math.max(searchOptions.limit ?? 6, 1), 10);
      const reranking = variant.rerank && options.reranker;
      const repo = searchOptions.repo ? key(searchOptions.repo) : null;
      const [vector] = await embedder.embed([query]);
      const terms = queryTerms(query);
      const column = variant.identifiers ? 'search_v2' : 'search';
      // Fixed SQL fragments chosen by the variant; nothing from the question is interpolated.
      const weight = variant.weighting === 'strong'
        ? `1.0 + CASE WHEN lower(r.repo) = ANY($8::text[]) THEN 0.6 ELSE 0 END
                + CASE WHEN coalesce(f.stars, 0) >= 50 THEN 0.5 WHEN coalesce(f.stars, 0) >= 5 THEN 0.25 ELSE 0 END
                + CASE WHEN f.pushed_at > now() - interval '180 days' THEN 0.3 WHEN f.pushed_at > now() - interval '730 days' THEN 0.1 ELSE 0 END`
        : `1.0 + CASE WHEN lower(r.repo) = ANY($8::text[]) THEN 0.004 ELSE 0 END
                + CASE WHEN coalesce(f.stars, 0) >= 50 THEN 0.003 WHEN coalesce(f.stars, 0) >= 5 THEN 0.0015 ELSE 0 END
                + CASE WHEN f.pushed_at > now() - interval '180 days' THEN 0.002 WHEN f.pushed_at > now() - interval '730 days' THEN 0.001 ELSE 0 END`;
      const orQuery = `(CASE WHEN $9 = '' THEN ''::tsquery ELSE to_tsquery('english', $9) END || CASE WHEN $10 = '' THEN ''::tsquery ELSE to_tsquery('simple', $10) END)`;
      const lexical = variant.lexical === 'and'
        ? `matched AS (
             SELECT c.id, ts_rank_cd(c.${column}, tsq.query) AS score
             FROM source_chunks c JOIN live ON live.id = c.revision_id,
                  LATERAL (SELECT websearch_to_tsquery('english', $1) AS query UNION ALL SELECT websearch_to_tsquery('simple', $1)) tsq
             WHERE c.${column} @@ tsq.query
           ),`
        : `matched AS (
             SELECT c.id, ts_rank(c.${column}, tsq.query, 1) AS score
             FROM source_chunks c JOIN live ON live.id = c.revision_id, (SELECT ${orQuery} AS query) tsq
             WHERE c.${column} @@ tsq.query
           ),`;
      const fileLegs = variant.summaries
        ? `file_semantic AS (
             SELECT f.revision_id, f.path, row_number() OVER (ORDER BY f.summary_embedding <=> $5::vector, f.id) AS rank
             FROM source_files f JOIN live ON live.id = f.revision_id
             WHERE f.summary_embedding IS NOT NULL ORDER BY f.summary_embedding <=> $5::vector LIMIT $4
           ),
           file_lexical AS (
             SELECT f.revision_id, f.path, row_number() OVER (ORDER BY ts_rank(f.summary_search, tsq.query, 1) DESC, f.id) AS rank
             FROM source_files f JOIN live ON live.id = f.revision_id, (SELECT ${orQuery} AS query) tsq
             WHERE f.summary_search @@ tsq.query ORDER BY ts_rank(f.summary_search, tsq.query, 1) DESC LIMIT $4
           ),
           file_hits AS (
             SELECT revision_id, path, sum(1.0 / ($6 + rank)) AS score
             FROM (SELECT * FROM file_semantic UNION ALL SELECT * FROM file_lexical) files GROUP BY revision_id, path
           ),`
        : '';
      // A file found by its description lends its score to its own chunks; the chunk-level legs then
      // decide which of that file's windows to show.
      const fileScores = variant.summaries
        ? `UNION ALL SELECT c.id, fh.score AS weight FROM file_hits fh JOIN source_chunks c ON c.revision_id = fh.revision_id AND c.path = fh.path`
        : '';
      const { rows } = await pool.query(
        // Every parameter is typed here once: each variant leaves some of them unused, and Postgres
        // cannot infer the type of a parameter it never sees.
        `WITH params AS (SELECT $1::text AS asked, $9::text AS split_terms, $10::text AS whole_terms),
         live AS (
           SELECT r.id, r.repo, r.commit_sha, coalesce(f.url, '') AS url, ${weight} AS weight
           FROM index_revisions r LEFT JOIN repo_facts f ON f.repo = r.repo
           WHERE r.status = 'live' AND r.embedding_dims = $3 AND ($2::text IS NULL OR lower(r.repo) = $2)
         ),
         ${lexical}
         lexical AS (
           SELECT id, row_number() OVER (ORDER BY max(score) DESC, id) AS rank
           FROM matched GROUP BY id ORDER BY max(score) DESC LIMIT $4
         ),
         semantic AS (
           SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> $5::vector, c.id) AS rank
           FROM source_chunks c JOIN live ON live.id = c.revision_id
           WHERE c.embedding IS NOT NULL ORDER BY c.embedding <=> $5::vector LIMIT $4
         ),
         ${fileLegs}
         fused AS (
           SELECT id, sum(weight) AS score FROM (
             SELECT id, 1.0 / ($6 + rank) AS weight FROM lexical
             UNION ALL SELECT id, 1.0 / ($6 + rank) AS weight FROM semantic
             ${fileScores}
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
        [query, repo, embedder.dims, CANDIDATES, toVectorLiteral(vector), RRF_K, reranking ? RERANK_POOL : limit, FEATURED, terms.split, terms.whole]);
      let ordered = rows;
      if (reranking && rows.length > 1) {
        try {
          const order = await options.reranker!(query, rows.map(row => ({
            repo: row.repo, path: row.path, symbols: row.symbols, startLine: row.start_line, endLine: row.end_line, content: row.content,
          })));
          ordered = order.map(index => rows[index]);
        } catch (error) {
          // A slow or failed reranker costs precision, never the answer: keep the fused order.
          console.error('Rerank failed, keeping fused order:', error instanceof Error ? error.message : error);
        }
      }
      ordered = ordered.slice(0, limit);
      return ordered.map((row, index) => ({
        repo: row.repo, path: row.path, language: row.language, symbols: row.symbols,
        startLine: row.start_line, endLine: row.end_line, commit: row.commit_sha,
        url: row.url ? sourceUrl({ url: row.url }, row.commit_sha, row.path, row.start_line, row.end_line) : '',
        snippet: clip(row.content, index < FULL_WINDOW_HITS ? MAX_TOP_SNIPPET_CHARS : MAX_SNIPPET_CHARS),
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
