// One indexing pass: discover the allowed repositories, skip every one whose head commit is already
// indexed, and re-embed only the windows whose text changed. The CLI (`npm run index`) and the API's
// daily timer both call this, and a Postgres advisory lock keeps two passes from overlapping.
import type { Pool } from 'pg';
import type { Config } from './config';
import { applySchema } from './db';
import type { Embedder } from './embeddings';
import type { GitHub } from './github';
import { indexRepo } from './indexer';
import { INCLUDED, selectRepos } from './repos';
import { summarizeMissing, type Summarizer } from './summaries';

// Any fixed number works; it only has to be the same for every process that indexes.
const INDEX_LOCK = 7_210_421;

export type IndexRun = { skipped?: 'locked'; failed: boolean; unchanged: number; updated: number; embedded: number };

export async function runIndex(pool: Pool, config: Config, github: GitHub, embedder: Embedder, options: {
  requested?: string[]; force?: boolean; dryRun?: boolean; log?: (message: string) => void; summarizer?: Summarizer;
} = {}): Promise<IndexRun> {
  const log = options.log ?? (message => console.log(message));
  const result: IndexRun = { failed: false, unchanged: 0, updated: 0, embedded: 0 };
  // A session-level lock needs one connection for the whole pass.
  const lock = await pool.connect();
  try {
    const { rows } = await lock.query('SELECT pg_try_advisory_lock($1) AS got', [INDEX_LOCK]);
    if (!rows[0].got) { log('Another index pass is running; skipping this one.'); return { ...result, skipped: 'locked' }; }
    try {
      await applySchema(pool);
      const requested = options.requested ?? [];
      const discovered = selectRepos(await github.repos(config.GITHUB_OWNER));
      const targets = requested.length ? discovered.filter(repo => requested.includes(repo.name)) : discovered;
      if (requested.length && targets.length !== requested.length) {
        const missing = requested.filter(name => !targets.some(repo => repo.name === name));
        throw new Error(`Unknown repository: ${missing.join(', ')}. Available: ${discovered.map(repo => repo.name).join(', ')}`);
      }
      log(`${targets.length} repositories to consider${config.GITHUB_TOKEN ? '' : ' (no GITHUB_TOKEN: 60 requests per hour)'}`);
      if (options.dryRun) {
        for (const repo of targets) log(`  ${repo.name} — ${repo.blurb}`);
        return result;
      }
      // Dropping a name from the allowlist must also drop what was already indexed under it,
      // or retrieval keeps quoting a repository the site no longer talks about.
      const names = [...INCLUDED];
      const dropped = await pool.query('DELETE FROM index_revisions WHERE repo <> ALL($1::text[]) RETURNING repo', [names]);
      await pool.query('DELETE FROM repo_facts WHERE repo <> ALL($1::text[])', [names]);
      if (dropped.rowCount) log(`Pruned ${dropped.rowCount} revision(s) for repositories off the allowlist: ${[...new Set(dropped.rows.map(row => row.repo))].join(', ')}`);

      for (const repo of targets) {
        try {
          const report = await indexRepo(pool, repo, config.REPO_CACHE_DIR, embedder, github, { force: options.force, log });
          if (report.unchanged) { result.unchanged++; log(`${report.repo}: unchanged at ${report.commit.slice(0, 8)}`); continue; }
          result.updated++;
          result.embedded += report.embedded;
          log(`${report.repo}: live at ${report.commit.slice(0, 8)} — ${report.files} files, ${report.chunks} chunks, ${report.embedded} embedded, ${report.reused} reused`);
        } catch (error) {
          result.failed = true;
          log(`${repo.name}: indexing failed, previous revision kept — ${error instanceof Error ? error.message : error}`);
        }
      }
      // Summaries are filled for every live file still missing one, including repositories that did
      // not change today, so a new model or a first run backfills without a forced reindex.
      if (options.summarizer) {
        await summarizeMissing(pool, options.summarizer, embedder, { log })
          .catch(error => log(`summaries: skipped — ${error instanceof Error ? error.message : error}`));
      }
      log(`Index pass done: ${result.updated} updated, ${result.unchanged} unchanged, ${result.embedded} windows embedded.`);
      return result;
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1)', [INDEX_LOCK]);
    }
  } finally {
    lock.release();
  }
}
