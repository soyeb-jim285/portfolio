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
