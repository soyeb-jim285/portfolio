import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { configSchema } from './config';
import { createEmbedder } from './embeddings';
import { createRetrieval } from './retrieval';

// Checked-in retrieval evaluation: real questions against the live index, no model involved.
type Case = { question: string; expectAnyPath: string[]; repo?: string };

const config = configSchema.parse(process.env);
const { cases } = JSON.parse(await readFile(new URL('../evals/code-questions.json', import.meta.url), 'utf8')) as { cases: Case[] };
const pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 20000 });
const retrieval = createRetrieval(pool, createEmbedder(config.OPENROUTER_API_KEY, config.OPENROUTER_EMBEDDING_MODEL, config.OPENROUTER_EMBEDDING_DIMS));

let passed = 0;
const failures: string[] = [];
try {
  const indexed = await retrieval.indexedRepos();
  if (!indexed.length) throw new Error('No live index. Run `npm run index` first.');
  console.log(`Index: ${indexed.map(entry => `${entry.repo}@${entry.commit.slice(0, 8)} (${entry.chunks} chunks)`).join(', ')}\n`);

  for (const testCase of cases) {
    const hits = await retrieval.search(testCase.question, { repo: testCase.repo, limit: 6 });
    const paths = hits.map(hit => hit.path);
    const rank = paths.findIndex(path => testCase.expectAnyPath.includes(path));
    if (rank >= 0) { passed++; console.log(`PASS  rank ${rank + 1}  ${testCase.question}\n      ${hits[rank].repo}/${paths[rank]}:${hits[rank].startLine}-${hits[rank].endLine}`); }
    else { failures.push(testCase.question); console.log(`FAIL  ${testCase.question}\n      expected one of ${testCase.expectAnyPath.join(', ')}\n      got ${paths.join(', ') || 'no results'}`); }
  }
} finally { await pool.end(); }

console.log(`\n${passed}/${cases.length} retrieval cases passed.`);
if (failures.length) console.log(`Failed: ${failures.join(' | ')}`);
// One stubborn case should not block a release; a broad regression should.
process.exit(passed / cases.length >= 0.8 ? 0 : 1);
