import assert from 'node:assert/strict';
import test from 'node:test';
import knowledge from './knowledge.json' with { type: 'json' };
import { runTool } from './tools';

const context = { retrieval: {} as never, repoNames: [], contactEnabled: false, artifactsEnabled: false, maxArtifactBytes: 0 } as Parameters<typeof runTool>[0];

test('portfolio_details serves the write-ups the prompt no longer carries, and only known slugs', async () => {
  const hyprfm = await runTool(context, 'portfolio_details', JSON.stringify({ slug: 'hyprfm' }));
  assert.equal(hyprfm.failed, undefined);
  assert.match(hyprfm.result, /nemo and yazi/, 'user quotes come through the tool');
  assert.deepEqual(hyprfm.sources, [], 'a write-up is not a source file');
  const paper = await runTool(context, 'portfolio_details', JSON.stringify({ slug: 'pce-pinn-pipelines' }));
  assert.match(paper.result, /abstract/);
  assert.equal((await runTool(context, 'portfolio_details', JSON.stringify({ slug: '../etc/passwd' }))).failed, true);
  // What moved out of the prompt is exactly what the tool serves.
  for (const project of knowledge.projects) assert.ok(!('body' in project) && !('reception' in project), project.slug);
  for (const paper of knowledge.research) assert.ok(!('abstract' in paper), paper.slug);
});

test('github_activity reads live GitHub data for listed repositories only, and clips diffs', async () => {
  const paths: string[] = [];
  const github = {
    owner: 'soyeb-jim285',
    async get<T>(path: string): Promise<T> {
      paths.push(path);
      if (path.endsWith('/commits?per_page=1')) return [{ sha: 'abcdef1234567890', html_url: 'https://github.com/x/c', author: { login: 'jim' }, commit: { message: 'Fix copy\n\nbody', author: { date: '2026-09-18T10:00:00Z' } } }] as T;
      if (path.includes('/commits/abcdef1')) return { sha: 'abcdef1234567890', html_url: 'u', author: { login: 'jim' }, stats: { additions: 1, deletions: 0 }, commit: { message: 'Fix copy', author: { date: '' } },
        files: [{ filename: 'a.cpp', status: 'modified', additions: 1, deletions: 0, patch: 'x'.repeat(5000) }] } as T;
      throw new Error('unexpected path');
    },
  };
  const live = { ...context, repoNames: ['hyprfm'], github };
  const commits = await runTool(live, 'github_activity', JSON.stringify({ repo: 'HyprFM', kind: 'commits', limit: 1 }));
  assert.equal(commits.live, true, 'live data is never replayed from the answer cache');
  assert.match(commits.result, /abcdef12 .* jim: Fix copy link:/);
  assert.match(commits.result, /untrusted data/);
  const commit = await runTool(live, 'github_activity', JSON.stringify({ repo: 'hyprfm', kind: 'commit', sha: 'abcdef1' }));
  assert.ok(commit.result.length < 2500, 'a large patch is clipped');
  assert.equal((await runTool(live, 'github_activity', JSON.stringify({ repo: 'someone-elses', kind: 'commits' }))).failed, true);
  assert.equal((await runTool(live, 'github_activity', JSON.stringify({ repo: 'hyprfm', kind: 'commit', sha: '../../user' }))).failed, true);
  assert.deepEqual(paths, ['/repos/soyeb-jim285/HyprFM/commits?per_page=1', '/repos/soyeb-jim285/hyprfm/commits/abcdef1']);
  assert.equal((await runTool(context, 'github_activity', JSON.stringify({ repo: 'hyprfm', kind: 'commits' }))).failed, true, 'no client, no call');
});
