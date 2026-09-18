import assert from 'node:assert/strict';
import test from 'node:test';
import { workingLabel } from '../../src/lib/chat-progress';
import type { ToolActivity } from '../../src/lib/chat-stream';

test('working text follows real tool activity, including tools after an introductory answer', () => {
  const tool = (name: string, status: ToolActivity['status'] = 'running'): ToolActivity => ({ id: name, name, status, summary: '' });
  assert.equal(workingLabel(), 'Considering your request…');
  assert.equal(workingLabel([tool('search_knowledge')]), 'Searching the knowledge base…');
  assert.equal(workingLabel([tool('search_knowledge', 'done'), tool('read_source')]), 'Reading source code…');
  assert.equal(workingLabel([tool('create_artifact')], true), 'Creating your document…');
  assert.equal(workingLabel([tool('read_source', 'done')]), 'Reviewing the results…');
  assert.equal(workingLabel([tool('read_source', 'error')], true), 'Writing the response…');
  assert.equal(workingLabel([tool('new_tool')]), 'Working on your request…');
});
