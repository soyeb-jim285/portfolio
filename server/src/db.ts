import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { answerQueries } from './db/answers';
import { artifactQueries } from './db/artifacts';
import { bookingQueries } from './db/bookings';
import { budgetQueries } from './db/budgets';
import { contactQueries } from './db/contact';
import { sessionQueries } from './db/sessions';

export type { AnswerMetric } from './db/answers';

// Applied in exactly this order and sent as one string: later files depend on earlier ones.
const schemaPaths = ['01-core.sql', '02-code-index.sql', '03-visitor-actions.sql', '04-repos-metrics-search.sql'].map(name => new URL(`./schema/${name}`, import.meta.url));

// Every entry point applies the schema, so the API and the indexer can start in either order.
// A serverless database may be suspended, and the first connection pays its cold start, so retry once.
export async function applySchema(pool: Pool) {
  const schema = (await Promise.all(schemaPaths.map(path => readFile(path, 'utf8')))).join('\n');
  // A migration may rewrite a table (adding a stored generated column does), which can outlast the
  // pool's statement timeout, so it runs on its own connection with the timeout lifted and restored.
  const run = async () => {
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 0');
      await client.query(schema);
    } finally {
      await client.query('RESET statement_timeout').catch(() => {});
      client.release();
    }
  };
  try { await run(); }
  catch (error) {
    console.error('First database connection failed, retrying:', error instanceof Error ? error.message : error);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await run();
  }
}

export type Db = Awaited<ReturnType<typeof createDb>>;

export async function createDb(url: string, ttlDays: number, metricsDays = 90) {
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 20000, statement_timeout: 15000, idle_in_transaction_session_timeout: 15000 });
  pool.on('error', error => console.error('Database pool error:', error.message));
  await applySchema(pool);
  const ttl = `${ttlDays} days`;

  return {
    // Exposed so retrieval can share the same pool.
    pool,
    ...sessionQueries(pool, ttl),
    ...answerQueries(pool),
    ...contactQueries(pool),
    ...artifactQueries(pool),
    ...bookingQueries(pool),
    ...budgetQueries(pool),
    async sweep() {
      await pool.query(`DELETE FROM contact_drafts WHERE expires_at <= now()`);
      await pool.query(`DELETE FROM bookings WHERE expires_at <= now()`);
      // Keep ownership rows until the object-storage sweep has removed their documents.
      const { rowCount } = await pool.query(`DELETE FROM sessions s WHERE expires_at <= now() AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.session_id = s.id)`);
      await pool.query(`DELETE FROM usage_daily WHERE day < CURRENT_DATE - 30`);
      await pool.query(`DELETE FROM answer_cache WHERE expires_at <= now()`);
      await pool.query(`DELETE FROM rate_limits WHERE expires_at <= now()`);
      await pool.query(`DELETE FROM answer_metrics WHERE created_at < now() - make_interval(days => $1)`, [metricsDays]);
      return rowCount ?? 0;
    },
    close: () => pool.end(),
  };
}
