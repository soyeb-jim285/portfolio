import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app';
import { config, db, pool, fakeRetrieval, fakeMailer, fakeStorage, fakeScheduler, sse, mockClient, ask, newSession, events } from './test-app-helpers';

test('provider failure and truncated streams never report completion', async () => {
  for (const upstream of [new Response('secret-provider-detail', { status: 500 }), new Response(sse('partial', null)), new Response(sse('', 'stop'))]) {
    await pool.query('TRUNCATE sessions, usage_daily CASCADE');
    const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), mockClient(async () => upstream));
    const token = await newSession(app);
    const output = await (await app.fetch(ask(token))).text();
    assert.match(output, /"type":"error"/);
    assert.doesNotMatch(output, /"type":"done"|secret-provider-detail/);
  }
});

test('timeout aborts upstream and releases the concurrency slot', async () => {
  let aborted = 0;
  // The timeout must outlast a round trip to a remote database, or the slot frees before the second call authenticates.
  const app = createApp({ ...config, REQUEST_TIMEOUT_MS: 1200, MAX_CONCURRENT_REQUESTS: 1 }, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), mockClient(async (_url, init) =>
    new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { aborted++; reject(new DOMException('Aborted', 'AbortError')); }, { once: true }); })));
  const token = await newSession(app);
  const first = await app.fetch(ask(token));
  assert.equal((await app.fetch(ask(token))).status, 429);
  assert.match(await first.text(), /timed out/);
  const second = await app.fetch(ask(token));
  assert.equal(second.status, 200);
  await second.text();
  assert.equal(aborted, 2);
});

test('disconnect cancels the upstream request', async () => {
  let notify: () => void = () => {};
  const aborted = new Promise<void>(resolve => { notify = resolve; });
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), mockClient(async (_url, init) =>
    new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { notify(); reject(new DOMException('Aborted', 'AbortError')); }, { once: true }); })));
  const token = await newSession(app);
  const response = await app.fetch(ask(token));
  await response.body!.cancel();
  await Promise.race([aborted, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Upstream was not cancelled')), 1000); timer.unref(); })]);
});

test('a long answer that keeps streaming outlives the idle timeout', async () => {
  // Four chunks 400ms apart take 1.6s in total, well past a 1s timeout that only measures silence.
  const client = mockClient(async () => new Response(new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const [index, word] of ['Slow ', 'but ', 'steady ', 'answer.'].entries()) {
        await new Promise(resolve => setTimeout(resolve, 400));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: word }, finish_reason: index === 3 ? 'stop' : null }] })}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const app = createApp({ ...config, REQUEST_TIMEOUT_MS: 1000 }, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  const token = await newSession(app);
  const frames = events(await (await app.fetch(ask(token, 'Take your time'))).text());
  assert.equal(frames.filter(event => event.type === 'delta').map(event => event.text).join(''), 'Slow but steady answer.');
  assert.equal(frames.at(-1).type, 'done');
});
