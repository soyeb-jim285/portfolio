// Indexing command. Discovers the public repositories, skips the ones whose head commit is
// already indexed, and re-embeds only the windows whose text changed.
import { Pool } from 'pg';
import { configSchema } from './config';
import { applySchema } from './db';
import { createEmbedder } from './embeddings';
import { createGitHub } from './github';
import { indexRepo } from './indexer';
import { selectRepos } from './repos';

const config = configSchema.parse(process.env);
const requested = process.argv.slice(2).filter(argument => !argument.startsWith('--'));
const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');

const pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 20000 });
const github = createGitHub(config.GITHUB_TOKEN);
const embedder = createEmbedder(config.OPENROUTER_API_KEY, config.OPENROUTER_EMBEDDING_MODEL, config.OPENROUTER_EMBEDDING_DIMS);

let failed = false;
try {
  await applySchema(pool);
  const discovered = selectRepos(await github.repos(config.GITHUB_OWNER));
  const targets = requested.length ? discovered.filter(repo => requested.includes(repo.name)) : discovered;
  if (requested.length && targets.length !== requested.length) {
    const missing = requested.filter(name => !targets.some(repo => repo.name === name));
    throw new Error(`Unknown repository: ${missing.join(', ')}. Available: ${discovered.map(repo => repo.name).join(', ')}`);
  }
  console.log(`${targets.length} repositories to consider${config.GITHUB_TOKEN ? '' : ' (no GITHUB_TOKEN: 60 requests per hour)'}`);
  if (dryRun) {
    for (const repo of targets) console.log(`  ${repo.name} — ${repo.blurb}`);
    process.exit(0);
  }

  let embedded = 0;
  let unchanged = 0;
  for (const repo of targets) {
    try {
      const report = await indexRepo(pool, repo, config.REPO_CACHE_DIR, embedder, github, { force, log: message => console.log(message) });
      if (report.unchanged) { unchanged++; console.log(`${report.repo}: unchanged at ${report.commit.slice(0, 8)}`); continue; }
      embedded += report.embedded;
      console.log(`${report.repo}: live at ${report.commit.slice(0, 8)} — ${report.files} files, ${report.chunks} chunks, ${report.embedded} embedded, ${report.reused} reused`);
    } catch (error) {
      failed = true;
      console.error(`${repo.name}: indexing failed, previous revision kept —`, error instanceof Error ? error.message : error);
    }
  }
  console.log(`\nDone: ${unchanged} unchanged, ${embedded} windows embedded.`);
} catch (error) {
  failed = true;
  console.error('Indexing run failed:', error instanceof Error ? error.message : error);
} finally { await pool.end(); }
process.exit(failed ? 1 : 0);
