import assert from 'node:assert/strict';
import test from 'node:test';
import { CLIENT_HEADERS, createApp } from './app';
import { config, db, pool, fakeRetrieval, fakeMailer, fakeStorage, fakeScheduler, sse, mockClient, replying, ask, newSession } from './test-app-helpers';

test('rejects invalid input, disallowed origins and oversized bodies before the model', async () => {
  let calls = 0;
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), mockClient(async () => { calls++; return new Response(sse('ok')); }));
  const token = await newSession(app);
  assert.equal((await app.fetch(ask(token, 'hi', 'https://evil.example'))).status, 403);
  assert.equal((await app.fetch(ask(token, ' '))).status, 400);
  // Chat cannot borrow the much larger transcription upload budget.
  assert.equal((await app.fetch(ask(token, 'a'.repeat(200_001)))).status, 413);
  const extra = await app.fetch(new Request('http://localhost/v1/chat', { method: 'POST', body: JSON.stringify({ message: 'hi', role: 'system' }), headers: { 'Content-Type': 'application/json', Origin: config.SITE_ORIGIN, Authorization: `Bearer ${token}` } }));
  assert.equal(extra.status, 400);
  assert.equal(calls, 0);
});

test('the daily budget is shared across processes and survives a restart', async () => {
  const limited = { ...config, MAX_REQUESTS_PER_DAY: 2 };
  let calls = 0;
  const app = createApp(limited, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), mockClient(async () => { calls++; return new Response(sse('ok')); }));
  const token = await newSession(app);
  await (await app.fetch(ask(token))).text();
  const restarted = createApp(limited, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), mockClient(async () => { calls++; return new Response(sse('ok')); }));
  await (await restarted.fetch(ask(token))).text();
  assert.equal((await restarted.fetch(ask(token))).status, 429);
  assert.equal(calls, 2);
  assert.equal((await pool.query('SELECT requests FROM usage_daily')).rows[0].requests, 2);
});

test('per-address burst limit applies to every /v1 route', async () => {
  const app = createApp({ ...config, REQUESTS_PER_MINUTE: 2 }, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), replying().client);
  await newSession(app);
  await newSession(app);
  assert.equal((await app.fetch(new Request('http://localhost/v1/sessions', { method: 'POST', headers: { Origin: config.SITE_ORIGIN } }))).status, 429);
});

test('burst limits are atomic across app instances and provide a retry time', async () => {
  const limited = { ...config, REQUESTS_PER_MINUTE: 2 };
  const first = createApp(limited, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), replying().client);
  const second = createApp(limited, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), replying().client);
  const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).fetch(new Request('http://localhost/v1/sessions', { method: 'POST', headers: { Origin: config.SITE_ORIGIN, 'X-Forwarded-For': `192.0.2.${index}` } }))));
  assert.equal(responses.filter(response => response.status === 201).length, 2);
  for (const response of responses.filter(response => response.status === 429)) assert.ok(Number(response.headers.get('Retry-After')) > 0);
  await pool.query("UPDATE rate_limits SET expires_at = now() - interval '1 second'");
  await newSession(second);
});

test('private API responses prohibit browser caching and malformed tokens never query sessions', async () => {
  let touches = 0;
  const guarded = { ...db, touchSession: async (token: string) => { touches++; return db.touchSession(token); } };
  const app = createApp(config, guarded, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), replying().client);
  const session = await app.fetch(new Request('http://localhost/v1/sessions', { method: 'POST', headers: { Origin: config.SITE_ORIGIN } }));
  assert.equal(session.headers.get('Cache-Control'), 'no-store');
  assert.equal(session.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await app.fetch(ask('invalid-token'))).status, 401);
  assert.equal(touches, 0);
});

test('the preflight allows every header the browser client sends', async () => {
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler());
  // These are the headers src/lib/chat-stream.ts actually sets; a new one must be added to CLIENT_HEADERS.
  const sentByClient = ['content-type', 'authorization', 'x-time-zone', 'x-turnstile-token'];
  for (const path of ['/v1/chat', '/v1/sessions', '/v1/contact', '/v1/bookings']) {
    const preflight = await app.fetch(new Request(`http://localhost${path}`, {
      method: 'OPTIONS',
      headers: { Origin: config.SITE_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': sentByClient.join(', ') },
    }));
    assert.ok(preflight.status < 300, `${path} preflight returned ${preflight.status}`);
    const allowed = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const header of sentByClient) assert.ok(allowed.includes(header), `${path} preflight does not allow ${header}`);
  }
  assert.deepEqual(CLIENT_HEADERS.map(header => header.toLowerCase()).sort(), sentByClient.slice().sort());
});
