// Writes evaluation questions from the indexed code, so the eval is not only one person's phrasing
// of file names they had just read. For each sampled file a model writes three questions in three
// voices, and any question that leaks the file's own identifiers is thrown away, because a question
// that names the code tests string matching, not retrieval.
//
//   npm run eval:generate -- --per-repo 5 > evals/generated-questions.json
//
// Read-only against the index. Review the output before committing it.
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { Pool } from 'pg';
import { configSchema } from './config';

const args = process.argv.slice(2);
const perRepo = Number(args[args.indexOf('--per-repo') + 1]) || 5;
const config = configSchema.parse(process.env);
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : config.OPENROUTER_MODEL;
const pool = new Pool({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 20000 });
const client = new OpenAI({ apiKey: config.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 1 });

const CODE = /\.(cpp|cc|h|hpp|py|ts|tsx|js|mjs|qml|swift|sh|lua|rs|go|java|kt|astro)$/;
const PROMPT = `You write evaluation questions for a code search engine over a developer's portfolio repositories.
Given one source file, write three questions that this file answers better than any other file would:
- "visitor": how a curious portfolio visitor would ask, naming the project in plain words.
- "keyword": a 3 to 7 word search a developer would type, no project name.
- "recruiter": how a technical recruiter would ask whether the developer has built this kind of thing.
Never use identifiers from the code: no function, class, type, variable or file names, and no words glued from them. Describe the behaviour instead.
Return JSON {"visitor": "...", "keyword": "...", "recruiter": "..."}.`;

// What gives the answer away is the code's own compound names used as one token (DrawingCanvas,
// format_partitions, devicemodel), not the ordinary words they are built from: a question about
// mounting will say "mount", and should. So compound names are banned whole, and a single-word name
// only when it is long enough to be a coined term rather than English.
function bannedWords(path: string, symbols: string[]) {
  const words = new Set<string>();
  for (const name of [path.split('/').pop()!.replace(/\.[^.]+$/, ''), ...symbols]) {
    const parts = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
    const whole = parts.join('').toLowerCase();
    if ((parts.length >= 2 && whole.length >= 6) || whole.length >= 10) words.add(whole);
  }
  return [...words];
}
// Compared token by token: "format partitions" is two plain words, "formatPartitions" is a leak.
const leaks = (question: string, banned: string[]) => {
  const tokens = new Set((question.match(/[A-Za-z0-9_]+/g) ?? []).map(token => token.replace(/_/g, '').toLowerCase()));
  return banned.filter(word => tokens.has(word));
};

// A header and its implementation answer the same questions.
const siblings = (path: string, all: Set<string>) => {
  const stem = path.replace(/\.[^.]+$/, '');
  return ['.h', '.hpp', '.cpp', '.cc'].map(extension => stem + extension).filter(candidate => candidate !== path && all.has(candidate));
};

try {
  const { rows: files } = await pool.query<{ repo: string; path: string; line_count: number; content: string; content_hash: Buffer }>(
    `SELECT r.repo, f.path, f.line_count, f.content, f.content_hash FROM source_files f JOIN index_revisions r ON r.id = f.revision_id
     WHERE r.status = 'live' ORDER BY r.repo, f.path`);
  const { rows: symbolRows } = await pool.query<{ repo: string; path: string; symbols: string[] }>(
    `SELECT r.repo, c.path, array_agg(DISTINCT s) AS symbols FROM source_chunks c JOIN index_revisions r ON r.id = c.revision_id, unnest(c.symbols) AS s
     WHERE r.status = 'live' GROUP BY r.repo, c.path`);
  const symbolsOf = new Map(symbolRows.map(row => [`${row.repo}/${row.path}`, row.symbols]));

  const cases: Record<string, unknown>[] = [];
  const rejected: string[] = [];
  const byRepo = new Map<string, typeof files>();
  for (const file of files) if (CODE.test(file.path) && file.line_count >= 20 && !/(^|\/)(tests?|__tests__)\//.test(file.path)) byRepo.set(file.repo, [...(byRepo.get(file.repo) ?? []), file]);

  for (const [repo, candidates] of byRepo) {
    // Deterministic sample: the same index gives the same files, so a rerun is comparable.
    const sample = [...candidates].sort((a, b) => createHash('sha256').update(a.path).digest().compare(createHash('sha256').update(b.path).digest())).slice(0, perRepo);
    const paths = new Set(files.filter(file => file.repo === repo).map(file => file.path));
    for (const file of sample) {
      const banned = bannedWords(file.path, symbolsOf.get(`${repo}/${file.path}`) ?? []);
      const response = await client.chat.completions.create({
        model, temperature: 0.4, max_tokens: 400, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: `Project: ${repo}\nPath: ${file.path}\n\n${file.content.split('\n').slice(0, 220).join('\n').slice(0, 14000)}` }],
      });
      let parsed: Record<string, string> = {};
      try { parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}'); } catch { /* counted as rejected below */ }
      for (const style of ['visitor', 'keyword', 'recruiter']) {
        const question = String(parsed[style] ?? '').trim();
        const leaked = leaks(question, banned);
        if (!question || leaked.length) { rejected.push(`${repo}/${file.path} [${style}] ${question || '(empty)'}${leaked.length ? `  leaks: ${leaked.join(', ')}` : ''}`); continue; }
        cases.push({ question, expectAnyPath: [file.path, ...siblings(file.path, paths)], repo, style });
      }
    }
  }
  console.error(`${cases.length} questions kept, ${rejected.length} rejected for leaking identifiers or being empty:`);
  for (const line of rejected) console.error(`  ${line}`);
  console.log(JSON.stringify({ generatedBy: model, generatedAt: new Date().toISOString().slice(0, 10), perRepo, cases }, null, 2));
} finally { await pool.end(); }
