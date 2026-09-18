// Indexing command. The pass itself lives in index-run.ts, shared with the API's daily timer.
import { Pool } from 'pg';
import { configSchema } from './config';
import { createEmbedder } from './embeddings';
import { createGitHub } from './github';
import { runIndex } from './index-run';

const config = configSchema.parse(process.env);
const pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 20000 });
let failed = false;
try {
  const result = await runIndex(pool, config, createGitHub(config.GITHUB_TOKEN),
    createEmbedder(config.OPENROUTER_API_KEY, config.OPENROUTER_EMBEDDING_MODEL, config.OPENROUTER_EMBEDDING_DIMS), {
      requested: process.argv.slice(2).filter(argument => !argument.startsWith('--')),
      force: process.argv.includes('--force'),
      dryRun: process.argv.includes('--dry-run'),
    });
  failed = result.failed || result.skipped === 'locked';
} catch (error) {
  failed = true;
  console.error('Indexing run failed:', error instanceof Error ? error.message : error);
} finally { await pool.end(); }
process.exit(failed ? 1 : 0);
