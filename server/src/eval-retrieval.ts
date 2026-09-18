// Retrieval evaluation with ablations. Every question runs scoped to its repository and unscoped,
// under each search variant, against the live index. No model involved except the optional reranker.
//
//   npm run eval:retrieval                     all variants, headline on the held-out test split
//   npm run eval:retrieval -- --variants default --split all
//
// Cases come from evals/code-questions.json (hand-written) and evals/generated-questions.json
// (written by a model from the code, identifiers banned; see eval-generate.ts). They are split into
// dev and test by target file, so a question and its rephrasings never straddle the split: tune on
// dev, report test.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { Pool } from 'pg';
import { configSchema } from './config';
import { createEmbedder } from './embeddings';
import { createReranker } from './rerank';
import { BASELINE_VARIANT, DEFAULT_VARIANT, createRetrieval, type SearchVariant } from './retrieval';

type Case = { question: string; expectAnyPath: string[]; repo?: string; style?: string };
type Query = { id: string; question: string; expect: string[]; repo?: string; target: string; scope: 'scoped' | 'unscoped'; style: string; source: 'hand' | 'generated'; split: 'dev' | 'test' };

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const splitWanted = (flag('split') ?? 'test') as 'dev' | 'test' | 'all';

// Cumulative: each row adds one improvement to the row above it.
const VARIANTS: { name: string; variant: SearchVariant }[] = [
  { name: 'baseline', variant: BASELINE_VARIANT },
  { name: '+ OR matching', variant: { ...BASELINE_VARIANT, lexical: 'or' } },
  { name: '+ split identifiers', variant: { ...BASELINE_VARIANT, lexical: 'or', identifiers: true } },
  { name: '+ gentle weighting', variant: { ...BASELINE_VARIANT, lexical: 'or', identifiers: true, weighting: 'gentle' } },
  { name: '+ file summaries', variant: { ...BASELINE_VARIANT, lexical: 'or', identifiers: true, weighting: 'gentle', summaries: true } },
  { name: '+ rerank', variant: { ...BASELINE_VARIANT, lexical: 'or', identifiers: true, weighting: 'gentle', summaries: true, rerank: true } },
];
const sameVariant = (a: SearchVariant, b: SearchVariant) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const defaultName = VARIANTS.find(entry => sameVariant(entry.variant, DEFAULT_VARIANT))?.name ?? 'default';
const chosen = flag('variants')?.split(',').map(name => name.trim()) ?? null;
const variants = VARIANTS.filter(entry => !chosen || chosen.includes(entry.name) || (chosen.includes('default') && entry.name === defaultName));

// ---- statistics -----------------------------------------------------------------------------
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0; };
// Wilson score interval: honest for small samples and proportions near 0 or 1.
function wilson(hits: number, n: number) {
  if (!n) return [0, 0];
  const z = 1.96, p = hits / n, denominator = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}
// Exact McNemar test on paired outcomes: only the questions the two variants disagree on count.
function mcnemar(onlyA: number, onlyB: number) {
  const n = onlyA + onlyB;
  if (!n) return 1;
  const k = Math.min(onlyA, onlyB);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomial(n, i) * 0.5 ** n;
  return Math.min(1, 2 * tail);
}
function binomial(n: number, k: number) { let result = 1; for (let i = 1; i <= k; i++) result = result * (n - k + i) / i; return result; }
const pct = (value: number) => `${(100 * value).toFixed(1)}%`;

// ---- cases ----------------------------------------------------------------------------------
async function loadCases(file: string, source: Query['source']): Promise<Query[]> {
  const path = new URL(`../evals/${file}`, import.meta.url);
  if (!existsSync(path)) return [];
  const { cases } = JSON.parse(await readFile(path, 'utf8')) as { cases: Case[] };
  return cases.flatMap(item => {
    const target = `${(item.repo ?? '').toLowerCase()}/${item.expectAnyPath[0]}`;
    // By target file, so every phrasing of a question about one file lands on the same side.
    const split = createHash('sha256').update(target).digest()[0] % 2 === 0 ? 'dev' : 'test';
    const base = { question: item.question, expect: item.expectAnyPath, target, style: item.style ?? 'hand-written', source, split } as const;
    const queries: Query[] = [{ ...base, id: `${target}|${item.question}|unscoped`, scope: 'unscoped', repo: item.repo }];
    if (item.repo) queries.push({ ...base, id: `${target}|${item.question}|scoped`, scope: 'scoped', repo: item.repo });
    return queries;
  });
}

// ---- run ------------------------------------------------------------------------------------
const config = configSchema.parse(process.env);
const pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 20000 });
const embedder = createEmbedder(config.OPENROUTER_API_KEY, config.OPENROUTER_EMBEDDING_MODEL, config.OPENROUTER_EMBEDDING_DIMS);
const client = new OpenAI({ apiKey: config.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 1 });
const retrieval = createRetrieval(pool, embedder, { reranker: config.RERANK_MODEL ? createReranker(client, config.RERANK_MODEL) : undefined });

type Outcome = { query: Query; rank: number; ms: number };
let exitCode = 0;
try {
  const all = [...await loadCases('code-questions.json', 'hand'), ...await loadCases('generated-questions.json', 'generated')];
  const queries = all.filter(query => splitWanted === 'all' || query.split === splitWanted);
  const indexed = await retrieval.indexedRepos();
  if (!indexed.length) throw new Error('No live index. Run `npm run index` first.');
  const summarized = (await pool.query(`SELECT count(*) FILTER (WHERE summary IS NOT NULL)::int AS done, count(*)::int AS total
    FROM source_files f JOIN index_revisions r ON r.id = f.revision_id WHERE r.status = 'live'`)).rows[0];
  console.log(`Index: ${indexed.length} repositories, ${indexed.reduce((sum, entry) => sum + entry.chunks, 0)} chunks, ${summarized.done}/${summarized.total} files summarised`);
  console.log(`Cases: ${all.length} queries (${all.filter(q => q.source === 'hand').length} hand-written, ${all.filter(q => q.source === 'generated').length} generated), split ${splitWanted}: ${queries.length}\n`);

  // Warm the query-embedding cache first, so every variant is timed on the same footing and the
  // latency columns measure search itself. The embedding call is reported on its own.
  const embedMs: number[] = [];
  for (const question of new Set(queries.map(query => query.question))) {
    const started = performance.now();
    await embedder.embed([question]);
    embedMs.push(performance.now() - started);
  }

  const results = new Map<string, Outcome[]>();
  for (const { name, variant } of variants) {
    const outcomes: Outcome[] = [];
    for (const query of queries) {
      const started = performance.now();
      const hits = await retrieval.search(query.question, { repo: query.scope === 'scoped' ? query.repo : undefined, limit: 6, variant });
      const ms = performance.now() - started;
      const wantedRepo = query.repo?.toLowerCase();
      const rank = hits.findIndex(hit => query.expect.includes(hit.path) && (!wantedRepo || hit.repo.toLowerCase() === wantedRepo)) + 1;
      outcomes.push({ query, rank, ms });
    }
    results.set(name, outcomes);
  }

  const summarize = (outcomes: Outcome[]) => {
    const n = outcomes.length;
    const at = (k: number) => outcomes.filter(outcome => outcome.rank > 0 && outcome.rank <= k).length;
    return {
      n, hit1: at(1) / n, hit3: at(3) / n, hit6: at(6) / n, hit3n: at(3), hit6n: at(6),
      mrr: outcomes.reduce((sum, outcome) => sum + (outcome.rank ? 1 / outcome.rank : 0), 0) / n,
      p50: percentile(outcomes.map(outcome => outcome.ms), 0.5), p95: percentile(outcomes.map(outcome => outcome.ms), 0.95),
    };
  };

  const baseline = results.get('baseline');
  console.log(`Ablation, split ${splitWanted} (${queries.length} queries). p = exact McNemar on top-3 hits vs baseline.`);
  console.table(variants.map(({ name }) => {
    const outcomes = results.get(name)!;
    const stats = summarize(outcomes);
    const [low, high] = wilson(stats.hit3n, stats.n);
    let p = '';
    if (baseline && name !== 'baseline') {
      const onlyBase = outcomes.filter((outcome, index) => !(outcome.rank && outcome.rank <= 3) && baseline[index].rank && baseline[index].rank <= 3).length;
      const onlyThis = outcomes.filter((outcome, index) => outcome.rank && outcome.rank <= 3 && !(baseline[index].rank && baseline[index].rank <= 3)).length;
      p = `${mcnemar(onlyBase, onlyThis).toPrecision(2)} (+${onlyThis}/-${onlyBase})`;
    }
    return { variant: name, 'top-1': pct(stats.hit1), 'top-3': pct(stats.hit3), 'top-3 95% CI': `${pct(low)}–${pct(high)}`, 'top-6': pct(stats.hit6), MRR: stats.mrr.toFixed(3), 'p vs baseline': p, 'search p50 ms': Math.round(stats.p50), 'p95 ms': Math.round(stats.p95) };
  }));
  console.log(`Query embedding call: p50 ${Math.round(percentile(embedMs, 0.5))} ms, p95 ${Math.round(percentile(embedMs, 0.95))} ms (not included above).\n`);

  const headline = results.get(defaultName) ?? results.get(variants.at(-1)!.name)!;
  const group = (title: string, keyOf: (query: Query) => string) => {
    const buckets = new Map<string, Outcome[]>();
    for (const outcome of headline) buckets.set(keyOf(outcome.query), [...(buckets.get(keyOf(outcome.query)) ?? []), outcome]);
    console.log(`${defaultName}, by ${title}`);
    console.table([...buckets].sort().map(([bucket, outcomes]) => {
      const stats = summarize(outcomes);
      return { [title]: bucket, n: stats.n, 'top-1': pct(stats.hit1), 'top-3': pct(stats.hit3), 'top-6': pct(stats.hit6), MRR: stats.mrr.toFixed(3) };
    }));
  };
  group('scope', query => query.scope);
  group('style', query => query.style);
  group('source', query => query.source);
  group('repository', query => query.target.split('/')[0] || '(unscoped)');

  const misses = headline.filter(outcome => !outcome.rank);
  if (misses.length) console.log(`Misses under ${defaultName} (${misses.length}):\n${misses.map(outcome => `  [${outcome.query.scope}] ${outcome.query.question}  →  ${outcome.query.target}`).join('\n')}`);
  // A broad regression should fail the command; one stubborn question should not.
  exitCode = summarize(headline).hit6 >= 0.75 ? 0 : 1;
} finally { await pool.end(); }
process.exit(exitCode);
