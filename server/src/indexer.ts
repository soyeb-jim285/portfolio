import { execFile } from 'node:child_process';
import { readFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { chunkFile, languageOf, sha256, skipReason, MAX_FILE_BYTES } from './chunker';
import type { Embedder } from './embeddings';
import { toVectorLiteral } from './embeddings';
import type { GitHub } from './github';
import type { Repo } from './repos';

const run = promisify(execFile);
const INSERT_BATCH = 100;
const git = (args: string[], cwd?: string) => run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });

/** Head commit of the default branch, without cloning anything. */
export async function remoteHead(repo: Repo) {
  const { stdout } = await git(['ls-remote', repo.url, `refs/heads/${repo.branch}`]);
  return stdout.split(/\s+/)[0] ?? '';
}

// Only the file types worth answering questions from. Anything else is never downloaded.
const INDEXABLE = /\.(cpp|cc|cxx|h|hpp|py|ts|tsx|js|mjs|qml|swift|sh|bash|md|toml|json|ya?ml|nix|cmake|pro|lua|tex|astro|css|html|rs|go|java|kt|rb|sql)$|(^|\/)(CMakeLists\.txt|Makefile|Dockerfile|qmldir|PKGBUILD|flake\.nix)$/i;
const SKIP_PATH = /(^|\/)(\.git|node_modules|build|builddir|dist|out|target|vendor|third_party|3rdparty|external|subprojects|\.venv|__pycache__|\.cache|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)(\/|$)/i;
// Never citeable even when public: evaluation fixtures (every question would find its own answer key
// first) and the provenance ledger, whose notes are for the author, not for visitors.
const PRIVATE_PATH = /(^|\/)(evals\/|cv\.json$)/i;

export const wantedPaths = (entries: { path: string; size: number }[]) =>
  entries.filter(entry => INDEXABLE.test(entry.path) && !SKIP_PATH.test(entry.path) && !PRIVATE_PATH.test(entry.path) && entry.size > 0 && entry.size <= MAX_FILE_BYTES)
    .map(entry => entry.path);

/**
 * Fetch just the files worth indexing. A blobless clone brings the commit graph only, and a
 * sparse checkout limited to those paths downloads their contents and nothing else, so a
 * repository full of binaries costs the bytes of its source and no more.
 */
export async function fetchRepoFiles(repo: Repo, cacheDir: string, paths: string[]) {
  const dir = join(cacheDir, `${repo.owner}--${repo.name}`);
  await mkdir(cacheDir, { recursive: true });
  const cloned = await stat(join(dir, '.git')).then(() => true).catch(() => false);
  if (!cloned) {
    await rm(dir, { recursive: true, force: true });
    await git(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--single-branch', '--branch', repo.branch, repo.url, dir]);
  } else {
    await git(['fetch', '--depth', '1', '--filter=blob:none', 'origin', repo.branch], dir);
    await git(['reset', '--hard', 'FETCH_HEAD'], dir).catch(() => {});
  }
  // An explicit path list, so git fetches exactly these blobs.
  await git(['sparse-checkout', 'init', '--no-cone'], dir);
  await writeFile(join(dir, '.git', 'info', 'sparse-checkout'), paths.length ? `${paths.map(path => `/${path}`).join('\n')}\n` : '\n');
  // `checkout -f HEAD` populates the working tree; `checkout -- .` leaves it empty after a
  // --no-checkout clone, which silently yields an empty index.
  await git(['checkout', '-f', 'HEAD'], dir);
  const { stdout } = await git(['rev-parse', 'HEAD'], dir);
  return { dir, commit: stdout.trim() };
}

export type IndexReport = {
  repo: string; commit: string; files: number; chunks: number; embedded: number; reused: number;
  skipped: { path: string; reason: string }[]; revisionId: string; unchanged?: boolean;
};

// Written with every run, changed or not. Citations build their GitHub links from this row and the
// system prompt lists its description, so a repository without one links nowhere.
const saveFacts = (db: Pick<Pool, 'query'>, repo: Repo, commit: string) => db.query(
  `INSERT INTO repo_facts (repo, owner, url, branch, description, language, topics, stars, open_issues, pushed_at, indexed_commit)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
   ON CONFLICT (repo) DO UPDATE SET owner = $2, url = $3, branch = $4, description = $5, language = $6,
     topics = $7, stars = $8, open_issues = $9, pushed_at = $10, indexed_commit = $11, updated_at = now()`,
  [repo.name, repo.owner, repo.url, repo.branch, repo.blurb, repo.language ?? '', repo.topics ?? [],
   repo.stars ?? 0, repo.openIssues ?? 0, repo.pushedAt ?? null, commit]);

export async function indexRepo(
  pool: Pool, repo: Repo, cacheDir: string, embedder: Embedder, github: GitHub,
  options: { force?: boolean; log?: (message: string) => void } = {},
): Promise<IndexReport> {
  const log = options.log ?? (() => {});

  // Nothing to do unless the branch moved: one cheap call instead of a clone.
  const head = await remoteHead(repo);
  const live = await pool.query<{ commit_sha: string; file_count: number; chunk_count: number; id: string }>(
    `SELECT id, commit_sha, file_count, chunk_count FROM index_revisions WHERE repo = $1 AND status = 'live' AND embedding_dims = $2`,
    [repo.name, embedder.dims]);
  if (!options.force && head && live.rows[0]?.commit_sha === head) {
    // Facts still refresh: stars and descriptions move without a commit, and a revision indexed
    // before repo_facts existed would otherwise never get the URL its citations link to.
    await saveFacts(pool, repo, head);
    return { repo: repo.name, commit: head, files: live.rows[0].file_count, chunks: live.rows[0].chunk_count, embedded: 0, reused: live.rows[0].chunk_count, skipped: [], revisionId: live.rows[0].id, unchanged: true };
  }

  const { entries, truncated } = await github.tree(repo.owner, repo.name, repo.branch);
  if (truncated) log(`${repo.name}: tree listing truncated by GitHub; indexing what was returned`);
  const paths = wantedPaths(entries);
  if (!paths.length) throw new Error(`${repo.name}: nothing indexable`);
  const { dir, commit } = await fetchRepoFiles(repo, cacheDir, paths);
  log(`${repo.name}: commit ${commit.slice(0, 8)}, ${paths.length} of ${entries.length} files fetched`);

  const skipped: { path: string; reason: string }[] = [];
  const files: { path: string; language: string; content: string }[] = [];
  for (const path of paths) {
    const size = await stat(join(dir, path)).then(info => info.size).catch(() => Infinity);
    const content = size > MAX_FILE_BYTES ? '' : await readFile(join(dir, path), 'utf8').catch(() => '\0');
    const reason = skipReason(path, size, content);
    if (reason) { skipped.push({ path, reason }); continue; }
    files.push({ path, language: languageOf(path), content });
  }
  const chunks = files.flatMap(file => chunkFile(file.path, file.content));
  if (!chunks.length) throw new Error(`${repo.name}: nothing indexable at ${commit}`);

  const insertBatched = async (sql: string, columns: number, values: unknown[][]) => {
    for (let offset = 0; offset < values.length; offset += INSERT_BATCH) {
      const batch = values.slice(offset, offset + INSERT_BATCH);
      const placeholders = batch.map((_, row) => `(${Array.from({ length: columns }, (_, column) => `$${row * columns + column + 1}`).join(', ')})`).join(', ');
      await pool.query(`${sql} VALUES ${placeholders}`, batch.flat());
    }
  };

  // The content of the new revision is written first and stays invisible while it fills: every
  // reader filters on status = 'live'. Embedding a large repository takes hours, so it happens
  // between two short transactions rather than inside one long one. A run that dies leaves its
  // half-built revision behind on purpose: the next run reuses the vectors it already paid for.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO index_revisions (repo, commit_sha, embedding_model, embedding_dims, file_count, chunk_count)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [repo.name, commit, embedder.model, embedder.dims, files.length, chunks.length]);
  const revisionId = rows[0].id;

  await insertBatched(
    'INSERT INTO source_files (revision_id, path, language, line_count, content, content_hash)', 6,
    files.map(file => [revisionId, file.path, file.language, file.content.split('\n').length, file.content, sha256(file.content)]));
  await insertBatched(
    'INSERT INTO source_chunks (revision_id, path, language, symbols, symbol_text, start_line, end_line, content, content_hash)', 9,
    chunks.map(chunk => [revisionId, chunk.path, chunk.language, chunk.symbols, chunk.symbols.join(' '), chunk.startLine, chunk.endLine, chunk.content, chunk.contentHash]));

  // Carry over vectors for windows whose text is unchanged: the copy happens inside the
  // database, so an hourly run only pays for what was actually edited. Any earlier revision
  // counts, including one left half-built by a run that died, so its work is not paid for twice.
  const copied = await pool.query(
    `UPDATE source_chunks fresh SET embedding = previous.embedding
     FROM source_chunks previous JOIN index_revisions earlier ON earlier.id = previous.revision_id
     WHERE fresh.revision_id = $1 AND earlier.repo = $2 AND earlier.id <> $1 AND earlier.embedding_dims = $3
       AND previous.path = fresh.path AND previous.content_hash = fresh.content_hash
       AND previous.embedding IS NOT NULL AND fresh.embedding IS NULL`,
    [revisionId, repo.name, embedder.dims]);
  const reused = copied.rowCount ?? 0;

  const { rows: pending } = await pool.query<{ id: string; path: string; start_line: number; end_line: number; symbol_text: string; content: string }>(
    `SELECT id, path, start_line, end_line, symbol_text, content FROM source_chunks WHERE revision_id = $1 AND embedding IS NULL ORDER BY id`, [revisionId]);
  log(`${repo.name}: ${files.length} files, ${chunks.length} chunks, ${reused} reused, ${pending.length} to embed`);

  for (let offset = 0; offset < pending.length; offset += 64) {
    const batch = pending.slice(offset, offset + 64);
    const vectors = await embedder.embed(batch.map(chunk => `${repo.name}/${chunk.path}:${chunk.start_line}-${chunk.end_line}\n${chunk.symbol_text}\n${chunk.content}`));
    // One round trip per batch: a row-at-a-time update spends minutes on latency alone.
    await pool.query(
      `UPDATE source_chunks SET embedding = data.vector::vector
       FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS vector) data
       WHERE source_chunks.id = data.id`,
      [batch.map(chunk => chunk.id), vectors.map(toVectorLiteral)]);
    if (offset && offset % 3200 === 0) log(`${repo.name}: embedded ${offset} of ${pending.length}`);
  }

  // Promote atomically: readers see the old revision until this commit, then only the new one.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM index_revisions WHERE repo = $1 AND id <> $2`, [repo.name, revisionId]);
    await client.query(`UPDATE index_revisions SET status = 'live', promoted_at = now() WHERE id = $1`, [revisionId]);
    await saveFacts(client, repo, commit);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }

  return { repo: repo.name, commit, files: files.length, chunks: chunks.length, embedded: pending.length, reused, skipped, revisionId };
}
