import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmbedder } from './embeddings';

test('identical concurrent and repeated queries share one bounded, timed embedding call', async () => {
  let calls = 0;
  const embedder = createEmbedder('test', 'test', 2, async (_url, init) => {
    calls++;
    assert.ok(init?.signal);
    const { input } = JSON.parse(String(init?.body));
    return Response.json({ data: input.map(() => ({ embedding: [1, 2] })) });
  });
  const results = await Promise.all([embedder.embed(['same']), embedder.embed(['same']), embedder.embed(['same'])]);
  assert.deepEqual(results, [[[1, 2]], [[1, 2]], [[1, 2]]]);
  await embedder.embed(['same']);
  assert.equal(calls, 1);
  for (let n = 0; n < 256; n++) await embedder.embed([String(n)]);
  await embedder.embed(['same']);
  assert.equal(calls, 258, 'old entries are evicted rather than growing memory without bound');
});

test('permanent embedding errors are not retried or cached', async () => {
  let calls = 0;
  const embedder = createEmbedder('test', 'test', 2, async () => { calls++; return new Response('', { status: 401 }); });
  await assert.rejects(embedder.embed(['same']), /401/);
  await assert.rejects(embedder.embed(['same']), /401/);
  assert.equal(calls, 2);
});

test('invalid vectors cannot enter the cache or database', async () => {
  const embedder = createEmbedder('test', 'test', 2, async () => Response.json({ data: [{ embedding: [null, 1] }] }));
  await assert.rejects(embedder.embed(['same']), /Invalid/);
});
