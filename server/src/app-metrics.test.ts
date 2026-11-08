import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app';
import { warmAnswers } from './warm';
import { config, cachedConfig, db, pool, fakeRetrieval, fakeMailer, fakeStorage, fakeScheduler, sse, mockClient, ask, newSession } from './test-app-helpers';

// Metrics are written after the stream closes, without holding the answer up: poll briefly.
const metricRows = async (expected: number) => {
  for (let tries = 0; tries < 50; tries++) {
    const { rows } = await pool.query('SELECT * FROM answer_metrics ORDER BY id');
    if (rows.length >= expected) return rows;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return (await pool.query('SELECT * FROM answer_metrics ORDER BY id')).rows;
};

test('every answer records its timing, usage and outcome, and never its text', async () => {
  const usageFrame = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.0004 } })}\n\n`;
  const client = mockClient(async () => new Response(sse('HyprFM uses Qt.').replace('data: [DONE]', `${usageFrame.trim()}\n\ndata: [DONE]`)));
  const app = createApp(cachedConfig, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  const token = await newSession(app);
  await (await app.fetch(ask(token, 'What is HyprFM built with?'))).text();
  await (await app.fetch(ask(token, 'What is HyprFM built with?'))).text();

  const [live, replay] = await metricRows(2);
  assert.equal(live.kind, 'chat');
  assert.equal(live.cached, false);
  assert.equal(live.outcome, 'complete');
  assert.equal(live.model, 'test-model');
  assert.equal(live.prompt_tokens, 120);
  assert.equal(live.completion_tokens, 30);
  assert.equal(Number(live.cost_usd), 0.0004);
  assert.equal(live.steps, 1);
  assert.ok(live.first_token_ms !== null && live.first_token_ms <= live.total_ms);
  assert.equal(replay.cached, true, 'the second, identical question is a cache replay');
  assert.equal(Number(replay.cost_usd), 0);

  // Nothing identifying: no session, no address, no question, no answer.
  const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'answer_metrics'")).rows.map(row => row.column_name);
  for (const forbidden of ['session_id', 'ip', 'message', 'question', 'answer', 'content']) assert.ok(!columns.includes(forbidden), forbidden);
  assert.ok(!JSON.stringify([live, replay]).includes('HyprFM'), 'no text of the exchange reaches the table');
});

test('a warmed fixed question replays for a visitor in any time zone, and warm-ups never count as visitors', async () => {
  let modelCalls = 0;
  const client = mockClient(async () => { modelCalls++; return new Response(sse('HyprFM copies on a worker thread.')); });
  const warmApp = createApp(cachedConfig, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client, { metricsOrigin: 'warmup' });
  const question = 'How does HyprFM copy files without freezing the UI? Show me the code.';
  const tally = await warmAnswers(warmApp, db, config.SITE_ORIGIN, [question], () => {});
  assert.deepEqual(tally, { replayed: 0, answered: 1, failed: 0 });

  const app = createApp(cachedConfig, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  const token = await newSession(app);
  const visitor = await (await app.fetch(new Request('http://localhost/v1/chat', {
    method: 'POST', body: JSON.stringify({ message: question }),
    headers: { 'Content-Type': 'application/json', Origin: config.SITE_ORIGIN, Authorization: `Bearer ${token}`, 'X-Time-Zone': 'Europe/Berlin' },
  }))).text();
  assert.match(visitor, /"cached":true/, 'the Berlin visitor gets the answer warmed without a time zone');
  assert.equal(modelCalls, 1, 'only the warm-up called the model');

  const rows = await metricRows(2);
  assert.deepEqual(rows.map(row => [row.origin, row.cached]), [['warmup', false], ['visitor', true]]);
});

test('a failed answer is recorded with its outcome', async () => {
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), mockClient(async () => new Response('upstream down', { status: 500 })));
  const token = await newSession(app);
  await (await app.fetch(ask(token))).text();
  const [row] = await metricRows(1);
  assert.equal(row.outcome, 'error');
  assert.equal(row.first_token_ms, null);
});
