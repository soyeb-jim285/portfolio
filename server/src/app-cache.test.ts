import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app';
import { config, cachedConfig, db, pool, fakeRetrieval, fakeMailer, fakeStorage, fakeScheduler, sse, mockClient, ask, newSession, toolFrame, scripted, events, draftCall } from './test-app-helpers';

test('identical full context replays across sessions without calling the model or spending budget', async () => {
  let calls = 0;
  const client = mockClient(async () => { calls++; return new Response(sse(`Answer ${calls}.`), { headers: { 'Content-Type': 'text/event-stream' } }); });
  const app = createApp({ ...cachedConfig, MAX_MESSAGES_PER_SESSION: 40, MAX_REQUESTS_PER_DAY: 1 }, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  const token = await newSession(app);
  const turns = (first: string) => [first, 'a1', 'q2', 'a2', 'q3', 'a3'].map((content, index) => ({ role: index % 2 ? 'assistant' : 'user', content }));

  const fresh = events(await (await app.fetch(ask(token, 'q4', config.SITE_ORIGIN, turns('q1')))).text());
  assert.equal(calls, 1);
  assert.equal(fresh.find(event => event.type === 'usage').usage.cached, undefined);

  // Identical full context is safe to share across visitors.
  const otherToken = await newSession(app);
  const replayStarted = Date.now();
  const replay = events(await (await app.fetch(ask(otherToken, 'q4', config.SITE_ORIGIN, turns('q1')))).text());
  assert.ok(Date.now() - replayStarted >= 300, 'a replay is paced like a fast stream, not dumped at once');
  assert.equal(calls, 1, 'a cache hit must not call the model');
  assert.deepEqual(replay.filter(event => event.type === 'delta'), fresh.filter(event => event.type === 'delta'));
  assert.equal(replay.find(event => event.type === 'usage').usage.cached, true);
  assert.equal(replay.at(-1).type, 'done');

  // The daily budget of one was spent by the first answer; anything that misses the cache is refused.
  assert.equal((await app.fetch(ask(otherToken, 'q4', config.SITE_ORIGIN, turns('different private detail')))).status, 429, 'an identical suffix must not expose another visitor’s earlier context');
  assert.equal((await app.fetch(ask(token, 'q4', config.SITE_ORIGIN, turns('q1').slice(0, 5)))).status, 429);
  assert.equal((await pool.query('SELECT hits FROM answer_cache')).rows[0].hits, 1);
});

test('the cache misses on a new index or a disabled cache', async () => {
  let calls = 0;
  const client = mockClient(async () => { calls++; return new Response(sse('Answer.'), { headers: { 'Content-Type': 'text/event-stream' } }); });
  const token = await newSession(createApp(cachedConfig, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client));
  const run = async (app: ReturnType<typeof createApp>, request: Request) => { await (await app.fetch(request)).text(); };
  const app = createApp(cachedConfig, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  await run(app, ask(token, 'Same question'));
  await run(app, ask(token, 'Same question'));
  assert.equal(calls, 1);

  const reindexed = fakeRetrieval({ indexedRepos: async () => [{ ...(await fakeRetrieval().indexedRepos())[0], commit: 'b'.repeat(40) }] });
  await run(createApp(cachedConfig, db, reindexed, fakeMailer(), fakeStorage(), fakeScheduler(), client), ask(token, 'Same question'));
  assert.equal(calls, 2, 'a new indexed commit must miss');

  const off = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  await run(off, ask(token, 'Uncached question'));
  await run(off, ask(token, 'Uncached question'));
  assert.equal(calls, 4);
});

test('answers carrying session-bound events, failed tools or a length cut are never cached', async () => {
  const cases = [
    { name: 'draft', responses: [draftCall('{"name":"Ada","email":"ada@example.com","message":"I am hiring for Qt work."}'), sse('Here is a draft.')] },
    { name: 'failed tool', responses: [toolFrame([{ index: 0, id: 'call_bad', name: 'read_source', args: '{not json' }], 'tool_calls') + 'data: [DONE]\n\n', sse('I could not read it.')] },
    { name: 'length', responses: [sse('Cut off', 'length')] },
  ];
  for (const { name, responses } of cases) {
    await pool.query('TRUNCATE answer_cache');
    const { client } = scripted(...responses);
    const app = createApp(cachedConfig, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
    const token = await newSession(app);
    await (await app.fetch(ask(token, `Question for ${name}`))).text();
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM answer_cache')).rows[0].n, 0, `${name} must not be cached`);
  }
});
