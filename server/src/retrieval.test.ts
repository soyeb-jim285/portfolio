import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { applySchema } from './db';
import type { Embedder } from './embeddings';
import { indexRepo, wantedPaths } from './indexer';
import type { GitHub } from './github';
import { createRetrieval } from './retrieval';
import type { Repo } from './repos';

const run = promisify(execFile);
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database. These tests delete all rows, so never point it at a database you care about.');

// Deterministic, offline stand-in: a bag-of-characters vector is enough to rank by overlap.
const fakeEmbedder = (dims = 16): Embedder => ({
  model: 'test/fake-embedding', dims,
  async embed(texts) {
    return texts.map(text => {
      const vector = new Array(dims).fill(0);
      for (const character of text.toLowerCase()) vector[character.charCodeAt(0) % dims] += 1;
      const length = Math.hypot(...vector) || 1;
      return vector.map(value => value / length);
    });
  },
});

const pool = new Pool({ connectionString: url });
// Stands in for the GitHub tree call: the fixture repository is local, so list it from disk.
const fakeGitHub = {
  authenticated: false,
  async repos() { return []; },
  async tree() {
    const { readdir, stat: statFile } = await import('node:fs/promises');
    const walk = async (base: string, prefix = ''): Promise<{ path: string; size: number }[]> => {
      const entries = await readdir(join(base, prefix), { withFileTypes: true });
      const found: { path: string; size: number }[] = [];
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) found.push(...await walk(base, relative));
        else found.push({ path: relative, size: (await statFile(join(base, relative))).size });
      }
      return found;
    };
    return { entries: await walk(origin), truncated: false };
  },
} as unknown as GitHub;
let workspace = '';
let origin = '';
const repo: Repo = { name: 'hyprfm', owner: 'soyeb-jim285', url: '', branch: 'main', blurb: 'test fixture' };

const commitAll = async (message: string) => {
  await run('git', ['add', '-A'], { cwd: origin });
  await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message], { cwd: origin });
};

before(async () => {
  await applySchema(pool);
  await pool.query('TRUNCATE index_revisions CASCADE');
  workspace = await mkdtemp(join(tmpdir(), 'portfolio-index-'));
  origin = join(workspace, 'origin');
  await mkdir(join(origin, 'src'), { recursive: true });
  await run('git', ['init', '-q', '-b', 'main', origin]);
  await writeFile(join(origin, 'src/FileOps.cpp'), `#include "FileOps.h"\n\n// Copy jobs run on a worker pool so the QML interface never blocks.\nvoid FileOps::copy(const QList<QUrl> &sources) {\n  QtConcurrent::run(&pool, [=] { transfer(sources); });\n}\n\nvoid FileOps::cancel() {\n  aborted = true;\n}\n`);
  await writeFile(join(origin, 'src/Thumbnailer.cpp'), `#include "Thumbnailer.h"\n\n// Thumbnails are generated lazily and cached on disk.\nvoid Thumbnailer::request(const QString &path) {\n  queue.append(path);\n}\n`);
  await writeFile(join(origin, 'src/legacy.cpp'), 'void legacyHelper() {}\n');
  await writeFile(join(origin, '.env'), 'OPENROUTER_API_KEY=sk-should-never-be-indexed-1234567890\n');
  await mkdir(join(origin, 'build'), { recursive: true });
  await writeFile(join(origin, 'build/generated.cpp'), 'void generated() {}\n');
  await writeFile(join(origin, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  await commitAll('initial');
  repo.url = origin;
});
after(async () => { await pool.end(); await rm(workspace, { recursive: true, force: true }); });

test('indexes only reviewable source and pins the commit', async () => {
  const report = await indexRepo(pool, repo, join(workspace, 'cache'), fakeEmbedder(), fakeGitHub);
  // Sorted in JS: database collation decides the SQL order and differs between Postgres builds.
  const paths = (await pool.query('SELECT path FROM source_files')).rows.map(row => row.path).sort();
  assert.deepEqual(paths, ['src/FileOps.cpp', 'src/Thumbnailer.cpp', 'src/legacy.cpp'].sort());
  // Those files are filtered out before anything is fetched, so they never reach the checkout.
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM source_files WHERE path IN ('.env', 'build/generated.cpp', 'logo.png')")).rows[0].n, 0);
  assert.deepEqual(wantedPaths([
    { path: 'src/FileOps.cpp', size: 200 }, { path: '.env', size: 40 },
    { path: 'build/generated.cpp', size: 40 }, { path: 'logo.png', size: 400 },
    { path: 'src/huge.cpp', size: 10_000_000 },
    { path: 'server/evals/code-questions.json', size: 900 }, { path: 'src/data/cv.json', size: 900 },
  ]), ['src/FileOps.cpp']);
  assert.equal(report.commit.length, 40);
  const revision = (await pool.query('SELECT status, commit_sha, embedding_model, embedding_dims FROM index_revisions')).rows[0];
  assert.equal(revision.status, 'live');
  assert.equal(revision.commit_sha, report.commit);
  assert.equal(revision.embedding_model, 'test/fake-embedding');
  assert.equal(revision.embedding_dims, 16);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM source_chunks WHERE content LIKE '%sk-should-never%'")).rows[0].n, 0);
});

test('search finds code by identifier and by described behaviour, with real citations', async () => {
  const retrieval = createRetrieval(pool, fakeEmbedder());
  const byIdentifier = await retrieval.search('QtConcurrent');
  assert.equal(byIdentifier[0].path, 'src/FileOps.cpp');
  assert.ok(byIdentifier[0].symbols.includes('copy'));
  assert.equal(byIdentifier[0].startLine, 1);
  assert.ok(byIdentifier[0].endLine >= 9);
  assert.match(byIdentifier[0].url, new RegExp(`/blob/${byIdentifier[0].commit}/src/FileOps\\.cpp#L1-L`));
  assert.match(byIdentifier[0].snippet, /QtConcurrent::run/);

  const byBehaviour = await retrieval.search('thumbnail caching');
  assert.equal(byBehaviour[0].path, 'src/Thumbnailer.cpp');
  assert.equal((await retrieval.search('QtConcurrent', { limit: 1 })).length, 1);
  assert.equal((await retrieval.search('nothing matches xyzzy quux', { repo: 'quill' })).length, 0);
});

test('read_source returns real lines, clamps the window and refuses unknown paths', async () => {
  const retrieval = createRetrieval(pool, fakeEmbedder());
  const file = await retrieval.read('hyprfm', 'src/FileOps.cpp', 4, 6);
  assert.equal(file!.startLine, 4);
  assert.equal(file!.endLine, 6);
  assert.match(file!.content, /^void FileOps::copy/);
  assert.equal(file!.content.split('\n').length, 3);
  assert.match(file!.url, /#L4-L6$/);
  const clamped = await retrieval.read('hyprfm', 'src/FileOps.cpp', 1, 9999);
  assert.equal(clamped!.endLine, clamped!.lineCount);
  assert.equal(await retrieval.read('hyprfm', 'src/Nope.cpp'), null);
  assert.equal(await retrieval.read('quill', 'src/FileOps.cpp'), null);
  assert.deepEqual((await retrieval.listFiles('hyprfm')).map(entry => entry.path).sort(), ['src/FileOps.cpp', 'src/Thumbnailer.cpp', 'src/legacy.cpp'].sort());
});

test('a reindex swaps revisions atomically and drops deleted files', async () => {
  const retrieval = createRetrieval(pool, fakeEmbedder());
  const before = (await retrieval.indexedRepos())[0];
  await rm(join(origin, 'src/legacy.cpp'));
  await writeFile(join(origin, 'src/FileOps.cpp'), `#include "FileOps.h"\n\n// Copy jobs now report progress through a signal.\nvoid FileOps::copy(const QList<QUrl> &sources) {\n  emit progressChanged(0);\n}\n`);
  await commitAll('drop legacy, add progress');

  const report = await indexRepo(pool, repo, join(workspace, 'cache'), fakeEmbedder(), fakeGitHub);
  assert.notEqual(report.commit, before.commit);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM index_revisions WHERE repo = 'hyprfm'")).rows[0].n, 1);
  assert.equal(await retrieval.read('hyprfm', 'src/legacy.cpp'), null);
  assert.match((await retrieval.read('hyprfm', 'src/FileOps.cpp'))!.content, /progressChanged/);
  const after = (await retrieval.indexedRepos())[0];
  assert.equal(after.commit, report.commit);
  assert.equal((await retrieval.search('QtConcurrent')).every(hit => hit.commit === report.commit), true);
});

test('a failed reindex keeps the previous revision live', async () => {
  const retrieval = createRetrieval(pool, fakeEmbedder());
  const before = (await retrieval.indexedRepos())[0];
  // New text, so the run cannot satisfy itself from reused vectors and must call the embedder.
  await writeFile(join(origin, 'src/Newcomer.cpp'), 'void newcomer() { /* needs embedding */ }\n');
  await commitAll('add a file that must be embedded');
  const broken: Embedder = { model: 'test/fake-embedding', dims: 16, embed: async () => { throw new Error('provider down'); } };
  await assert.rejects(indexRepo(pool, repo, join(workspace, 'cache'), broken, fakeGitHub), /provider down/);
  const after = await retrieval.indexedRepos();
  assert.equal(after.length, 1);
  assert.equal(after[0].commit, before.commit, 'the live revision must not move');
  assert.equal(await retrieval.read('hyprfm', 'src/Newcomer.cpp'), null, 'the failed run must publish nothing');
  // The half-built revision is kept so the next run can reuse the vectors it already paid for.
  // Nothing reads it: every query filters on status = 'live'.
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM index_revisions WHERE repo = 'hyprfm' AND status = 'live'")).rows[0].n, 1);
});

test('an index built with different embedding dimensions is ignored until it is rebuilt', async () => {
  const mismatched = createRetrieval(pool, fakeEmbedder(32));
  assert.deepEqual(await mismatched.indexedRepos(), []);
  assert.deepEqual(await mismatched.search('QtConcurrent'), []);
  assert.equal(await mismatched.read('hyprfm', 'src/FileOps.cpp'), null);
});

test('a featured, starred repository outranks a scratch repository on an equal match', async () => {
  const retrieval = createRetrieval(pool, fakeEmbedder());
  const shared = `#include "FileOps.h"\n\n// Copy jobs now report progress through a signal.\nvoid FileOps::copy(const QList<QUrl> &sources) {\n  emit progressChanged(0);\n}\n`;
  const scratch = join(workspace, 'old-scratch');
  await mkdir(join(scratch, 'src'), { recursive: true });
  await run('git', ['init', '-q', '-b', 'main', scratch]);
  // A slightly better lexical match, so only the repository weight can put hyprfm first.
  await writeFile(join(scratch, 'src/FileOps.cpp'), `${shared}\n// progressChanged progressChanged progressChanged\n`);
  await run('git', ['add', '-A'], { cwd: scratch });
  await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'copy'], { cwd: scratch });

  const previous = origin;
  origin = scratch; // fakeGitHub.tree lists whichever fixture is being indexed
  try {
    await indexRepo(pool, { name: 'old-scratch', owner: 'soyeb-jim285', url: scratch, branch: 'main', blurb: 'scratch fixture' },
      join(workspace, 'cache'), fakeEmbedder(), fakeGitHub);
  } finally { origin = previous; }

  await pool.query("UPDATE repo_facts SET stars = 307, pushed_at = now() WHERE repo = 'hyprfm'");
  await pool.query("UPDATE repo_facts SET stars = 0, pushed_at = now() - interval '4 years' WHERE repo = 'old-scratch'");

  const hits = await retrieval.search('progressChanged');
  assert.equal(hits[0].repo, 'hyprfm', 'the featured, starred, recently pushed repository ranks first');
  assert.ok(hits.some(hit => hit.repo === 'old-scratch'), 'weighting reorders, it never hides');
  const scoped = await retrieval.search('progressChanged', { repo: 'old-scratch' });
  assert.equal(scoped[0].repo, 'old-scratch');
});
