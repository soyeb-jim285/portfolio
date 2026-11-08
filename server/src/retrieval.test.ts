import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Embedder } from './embeddings';
import { indexRepo, wantedPaths } from './indexer';
import { createRetrieval } from './retrieval';
import { commitIn, createFixture, fakeEmbedder, fakeGitHubOver, pool, repo, run } from './test-retrieval-helpers';

let workspace = '';
let origin = '';
const fakeGitHub = fakeGitHubOver(() => origin);
const commitAll = (message: string) => commitIn(origin, message);

before(async () => { ({ workspace, origin } = await createFixture()); });
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

test('repository weighting: strong lets a featured repo beat a better match, gentle only breaks ties', async () => {
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

  // The old policy: a multiplier of up to 2.4 puts the featured repository first even over a better match.
  const strong = await retrieval.search('progressChanged', { variant: { weighting: 'strong' } });
  assert.equal(strong[0].repo, 'hyprfm', 'strong weighting overrides the better match');
  // The default: weighting is a tie-breaker only, so the better match wins and both stay visible.
  const hits = await retrieval.search('progressChanged');
  assert.equal(hits[0].repo, 'old-scratch', 'gentle weighting lets the better match rank first');
  assert.ok(hits.some(hit => hit.repo === 'hyprfm'), 'weighting reorders, it never hides');
  const scoped = await retrieval.search('progressChanged', { repo: 'old-scratch' });
  assert.equal(scoped[0].repo, 'old-scratch');
});

test('a repository whose GitHub name has capitals can still be searched, read and listed', async () => {
  const retrieval = createRetrieval(pool, fakeEmbedder());
  const mixed = join(workspace, 'LeakNet');
  await mkdir(mixed, { recursive: true });
  await run('git', ['init', '-q', '-b', 'main', mixed]);
  await writeFile(join(mixed, 'leaknet_experiment.py'), 'def run_leak_experiment():\n    return "acoustic leak detection"\n');
  await run('git', ['add', '-A'], { cwd: mixed });
  await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'leak'], { cwd: mixed });
  const previous = origin;
  origin = mixed;
  try {
    await indexRepo(pool, { name: 'LeakNet', owner: 'soyeb-jim285', url: mixed, branch: 'main', blurb: 'mixed-case fixture' },
      join(workspace, 'cache'), fakeEmbedder(), fakeGitHub);
  } finally { origin = previous; }
  // The model is free to lowercase the name; GitHub keeps the capitals.
  for (const asked of ['LeakNet', 'leaknet']) {
    const hits = await retrieval.search('acoustic leak detection', { repo: asked });
    assert.equal(hits[0]?.path, 'leaknet_experiment.py', `search scoped to ${asked}`);
    assert.equal(hits[0].repo, 'LeakNet', 'citations keep the real name');
    const file = await retrieval.read(asked, 'leaknet_experiment.py');
    assert.equal(file?.repo, 'LeakNet', `read scoped to ${asked}`);
  }
  assert.ok((await retrieval.listFiles('leaknet')).some(file => file.path === 'leaknet_experiment.py'));
});
