import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { Pool } from 'pg';
import { configSchema } from './config';
import type { Embedder } from './embeddings';
import type { GitHub } from './github';
import { runIndex } from './index-run';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database.');
const pool = new Pool({ connectionString: url });
after(() => pool.end());

const config = configSchema.parse({ OPENROUTER_API_KEY: 'test', OPENROUTER_MODEL: 'test-model', SITE_ORIGIN: 'http://localhost:4321', DATABASE_URL: url });
const embedder: Embedder = { model: 'test/none', dims: 16, embed: async () => { throw new Error('nothing should be embedded'); } };

test('a pass that finds another pass running skips instead of indexing twice', async () => {
  let listed = 0;
  const github = { repos: async () => { listed++; return []; } } as unknown as GitHub;
  const holder = await pool.connect();
  try {
    await holder.query('SELECT pg_advisory_lock(7210421)');
    const blocked = await runIndex(pool, config, github, embedder, { log: () => {} });
    assert.equal(blocked.skipped, 'locked');
    assert.equal(listed, 0, 'a skipped pass never reaches GitHub');
  } finally {
    await holder.query('SELECT pg_advisory_unlock(7210421)');
    holder.release();
  }
  // With the lock free again, the pass runs and releases it afterwards.
  const ran = await runIndex(pool, config, github, embedder, { log: () => {} });
  assert.equal(ran.skipped, undefined);
  assert.equal(listed, 1);
  const again = await runIndex(pool, config, github, embedder, { log: () => {} });
  assert.equal(again.skipped, undefined, 'the lock was released after the previous pass');
});
