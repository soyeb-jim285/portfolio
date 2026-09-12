import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionExpired, streamAnswer, type StreamHandlers } from '../../src/lib/chat-stream';

const question = 'Explain Qt';
const noop: StreamHandlers = { text: () => {}, tool: () => {}, sources: () => {}, action: () => {}, draft: () => {}, artifact: () => {}, slots: () => {}, proposal: () => {}, usage: () => {}, image: () => {} };
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`;

test('browser stream consumer handles fragmented UTF-8 and CRLF frames', async t => {
  const data = new TextEncoder().encode(': keepalive\r\n\r\n' + frame({ version: 1, type: 'delta', text: '**Qt** → বাংলা' }) + frame({ version: 1, type: 'done', finishReason: 'length' }));
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    for (const byte of data) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } }));
  const updates: string[] = [];
  const result = await streamAnswer('http://localhost', 'token', question, new AbortController().signal, { ...noop, text: text => updates.push(text) });
  assert.deepEqual(result, { text: '**Qt** → বাংলা', finishReason: 'length' });
  assert.deepEqual(updates, ['**Qt** → বাংলা']);
});

test('browser stream consumer rejects truncated, empty and invalid completion events', async t => {
  for (const output of [
    frame({ version: 1, type: 'delta', text: 'Partial' }),
    frame({ version: 1, type: 'done', finishReason: 'stop' }),
    frame({ version: 1, type: 'done', finishReason: 'unknown' }),
    frame({ version: 2, type: 'delta', text: 'Wrong version' }),
  ]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(output, { headers: { 'content-type': 'text/event-stream' } }));
    await assert.rejects(streamAnswer('http://localhost', 'token', question, new AbortController().signal, noop));
    t.mock.restoreAll();
  }
});

test('browser stream consumer surfaces an expired session as its own error', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'Session is missing or expired.' }), { status: 401 }));
  await assert.rejects(streamAnswer('http://localhost', 'stale', question, new AbortController().signal, noop), SessionExpired);
});

test('browser stream consumer reports HTTP and streamed errors', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'Try later' }), { status: 429 }));
  await assert.rejects(streamAnswer('http://localhost', 'token', question, new AbortController().signal, noop), /Try later/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response(frame({ version: 1, type: 'error', message: 'Provider timed out' }), { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(streamAnswer('http://localhost', 'token', question, new AbortController().signal, noop), /Provider timed out/);
});

test('browser stream consumer surfaces tool activity and citations, and ignores unknown events', async t => {
  const source = { repo: 'hyprfm', path: 'src/FileOps.cpp', language: 'cpp', symbols: ['copy'], startLine: 1, endLine: 9, commit: 'a'.repeat(40), url: 'https://example.test/blob', snippet: 'void copy() {}' };
  const body = frame({ version: 1, type: 'tool', id: 'call_1', name: 'search_knowledge', summary: 'running', status: 'running' })
    + frame({ version: 1, type: 'tool', id: 'call_1', name: 'search_knowledge', summary: 'search "copy": 1 match', status: 'done', ms: 42 })
    + frame({ version: 1, type: 'sources', sources: [source] })
    + frame({ version: 1, type: 'reasoning-summary', text: 'from a newer server' })
    + frame({ version: 1, type: 'delta', text: 'Transfers run on a worker pool.' })
    + frame({ version: 1, type: 'done', finishReason: 'stop' });
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  const tools: unknown[] = [];
  const cited: unknown[] = [];
  const result = await streamAnswer('http://localhost', 'token', question, new AbortController().signal,
    { ...noop, tool: activity => tools.push(activity), sources: sources => cited.push(...sources) });
  assert.equal(result.text, 'Transfers run on a worker pool.');
  assert.deepEqual(tools.map((tool: any) => [tool.status, tool.ms]), [['running', undefined], ['done', 42]]);
  assert.deepEqual(cited, [source]);
});
