import assert from 'node:assert/strict';
import test from 'node:test';
import { workingLabel } from '../../src/lib/chat-progress';
import type { ToolActivity } from '../../src/lib/chat-stream';

test('working text follows real tool activity, including tools after an introductory answer', () => {
  const tool = (name: string, status: ToolActivity['status'] = 'running', detail?: Record<string, string>): ToolActivity => ({ id: name, name, status, summary: '', detail });
  assert.equal(workingLabel(), 'Thinking…');
  assert.equal(workingLabel([tool('search_knowledge')]), 'Searching the code…');
  assert.equal(workingLabel([tool('search_knowledge', 'running', { query: 'file copy worker', repo: 'hyprfm' })]), 'Searching hyprfm for “file copy worker”…');
  assert.equal(workingLabel([tool('search_knowledge', 'done'), tool('read_source', 'running', { repo: 'hyprfm', path: 'src/fileops/FileOperations.cpp' })]), 'Reading FileOperations.cpp in hyprfm…');
  assert.equal(workingLabel([tool('github_activity', 'running', { repo: 'hyprfm', kind: 'commits' })]), "Looking at hyprfm's latest commits on GitHub…");
  assert.equal(workingLabel([tool('github_activity', 'running', { repo: 'hyprfm', kind: 'commit', sha: 'e7ea3029366e' })]), 'Opening commit e7ea302 on GitHub…');
  assert.equal(workingLabel([tool('github_activity', 'running', { repo: 'hyprfm', kind: 'search', query: 'trash' })]), "Searching hyprfm's commits for “trash”…");
  assert.equal(workingLabel([tool('github_activity', 'running', { repo: 'hyprfm', kind: 'history', path: 'src/FileOperations.cpp' })]), 'Tracing the history of FileOperations.cpp…');
  assert.equal(workingLabel([tool('github_activity', 'running', { repo: 'hyprfm', kind: 'nonsense' })]), 'Checking hyprfm on GitHub…');
  assert.equal(workingLabel([tool('create_artifact')], true), 'Writing your document…');
  assert.equal(workingLabel([tool('read_source', 'done')]), 'Going through what I found…');
  assert.equal(workingLabel([tool('read_source', 'error')], true), 'Writing…');
  assert.equal(workingLabel([tool('new_tool')]), 'Working on it…');
});
