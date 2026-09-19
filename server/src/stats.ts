// Production numbers from answer_metrics: how fast, how costly, how often the cache and the tools
// answered. Read-only. Usage: npm run stats [-- --days 30] [--origin visitor|eval|warmup|all]
import { Pool } from 'pg';
import { configSchema } from './config';

const config = configSchema.parse(process.env);
const days = Number(process.argv[process.argv.indexOf('--days') + 1]) || 30;
const pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 20000 });
const wanted = (args: string[]) => args.includes('--origin') ? args[args.indexOf('--origin') + 1] : 'visitor';
const origin = ['visitor', 'eval', 'warmup', 'all'].includes(wanted(process.argv)) ? wanted(process.argv) : 'visitor';
// Visitors only by default: eval runs and cache warm-ups would otherwise pass for real traffic.
const since = `created_at > now() - make_interval(days => ${Math.max(1, Math.min(730, Math.round(days)))})${origin === 'all' ? '' : ` AND origin = '${origin}'`}`;
const show = async (title: string, sql: string) => { console.log(`\n${title}`); console.table((await pool.query(sql)).rows); };

try {
  await pool.query('BEGIN READ ONLY');
  console.log(`Answer metrics, last ${days} days, origin: ${origin}`);
  await show('Rows by origin (all traffic)', `SELECT origin, count(*)::int AS answers FROM answer_metrics WHERE created_at > now() - make_interval(days => ${Math.max(1, Math.min(730, Math.round(days)))}) GROUP BY origin ORDER BY origin`);
  await show('Answers', `
    SELECT kind, count(*)::int AS answers,
           round(100.0 * count(*) FILTER (WHERE cached) / count(*), 1) AS cache_hit_pct,
           round(100.0 * count(*) FILTER (WHERE outcome = 'complete') / count(*), 1) AS complete_pct,
           count(*) FILTER (WHERE outcome IN ('error', 'timeout'))::int AS failed
    FROM answer_metrics WHERE ${since} GROUP BY kind ORDER BY kind`);
  // Latency is reported for model answers and replays separately: a replay's milliseconds say
  // nothing about the model, and mixing them would flatter every percentile.
  await show('Latency, completed chat answers (ms)', `
    SELECT CASE WHEN cached THEN 'cache replay' ELSE 'model' END AS path, count(*)::int AS n,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY first_token_ms) AS first_token_p50,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY first_token_ms) AS first_token_p95,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY total_ms) AS total_p50,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY total_ms) AS total_p95
    FROM answer_metrics WHERE ${since} AND kind = 'chat' AND outcome IN ('complete', 'truncated') GROUP BY cached ORDER BY cached`);
  await show('Usage and cost, model answers', `
    SELECT count(*)::int AS n, round(avg(prompt_tokens))::int AS avg_prompt_tokens, round(avg(completion_tokens))::int AS avg_completion_tokens,
           round(avg(steps), 2) AS avg_model_steps, round(sum(cost_usd), 4) AS total_cost_usd, round(avg(cost_usd), 5) AS cost_per_answer_usd,
           round(100.0 * sum(cached_prompt_tokens) / nullif(sum(prompt_tokens), 0), 1) AS prompt_cached_pct, round(avg(reasoning_tokens))::int AS avg_reasoning_tokens,
           round(100.0 * count(*) FILTER (WHERE cardinality(tools) > 0) / nullif(count(*), 0), 1) AS used_tools_pct,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY tool_ms) AS tool_ms_p50
    FROM answer_metrics WHERE ${since} AND kind = 'chat' AND NOT cached`);
  await show('Tools', `
    SELECT tool, count(*)::int AS calls FROM answer_metrics, unnest(tools) AS tool WHERE ${since} AND NOT cached GROUP BY tool ORDER BY calls DESC`);
  await show('Per day', `
    SELECT created_at::date AS day, count(*)::int AS answers, count(*) FILTER (WHERE cached)::int AS replays,
           round(sum(cost_usd), 4) AS cost_usd
    FROM answer_metrics WHERE ${since} GROUP BY 1 ORDER BY 1 DESC LIMIT 14`);
} finally {
  await pool.query('ROLLBACK').catch(() => {});
  await pool.end();
}
