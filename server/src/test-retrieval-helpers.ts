import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { applySchema } from './db';
import type { Embedder } from './embeddings';
import type { GitHub } from './github';
import type { Repo } from './repos';

export const run = promisify(execFile);
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database. These tests delete all rows, so never point it at a database you care about.');

// Deterministic, offline stand-in: a bag-of-characters vector is enough to rank by overlap.
export const fakeEmbedder = (dims = 16): Embedder => ({
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

export const pool = new Pool({ connectionString: url });
// Stands in for the GitHub tree call: the fixture repository is local, so list it from disk.
export const fakeGitHubOver = (origin: () => string) => ({
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
    return { entries: await walk(origin()), truncated: false };
  },
}) as unknown as GitHub;
export const repo: Repo = { name: 'hyprfm', owner: 'soyeb-jim285', url: '', branch: 'main', blurb: 'test fixture' };

export const commitIn = async (cwd: string, message: string) => {
  await run('git', ['add', '-A'], { cwd });
  await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message], { cwd });
};

export const createFixture = async () => {
  await applySchema(pool);
  await pool.query('TRUNCATE index_revisions CASCADE');
  const workspace = await mkdtemp(join(tmpdir(), 'portfolio-index-'));
  const origin = join(workspace, 'origin');
  await mkdir(join(origin, 'src'), { recursive: true });
  await run('git', ['init', '-q', '-b', 'main', origin]);
  await writeFile(join(origin, 'src/FileOps.cpp'), `#include "FileOps.h"\n\n// Copy jobs run on a worker pool so the QML interface never blocks.\nvoid FileOps::copy(const QList<QUrl> &sources) {\n  QtConcurrent::run(&pool, [=] { transfer(sources); });\n}\n\nvoid FileOps::cancel() {\n  aborted = true;\n}\n`);
  await writeFile(join(origin, 'src/Thumbnailer.cpp'), `#include "Thumbnailer.h"\n\n// Thumbnails are generated lazily and cached on disk.\nvoid Thumbnailer::request(const QString &path) {\n  queue.append(path);\n}\n`);
  await writeFile(join(origin, 'src/legacy.cpp'), 'void legacyHelper() {}\n');
  await writeFile(join(origin, '.env'), 'OPENROUTER_API_KEY=sk-should-never-be-indexed-1234567890\n');
  await mkdir(join(origin, 'build'), { recursive: true });
  await writeFile(join(origin, 'build/generated.cpp'), 'void generated() {}\n');
  await writeFile(join(origin, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  await commitIn(origin, 'initial');
  repo.url = origin;
  return { workspace, origin };
};
