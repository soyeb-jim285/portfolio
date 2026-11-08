import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app';
import { config, db, pool, fakeRetrieval, fakeMailer, fakeStorage, fakeScheduler, mockClient, replying, ask, newSession } from './test-app-helpers';

// The SDK posts multipart to /audio/transcriptions; the mock answers that URL and records what arrived.
const transcribing = (text = 'What makes HyprFM interesting?') => {
  const seen: { url?: string; model?: string; filename?: string; bytes?: number } = {};
  const client = mockClient(async (url, init) => {
    seen.url = String(url);
    const body = init?.body as FormData;
    const file = body.get('file') as File;
    seen.model = String(body.get('model')); seen.filename = file.name; seen.bytes = file.size;
    return new Response(JSON.stringify({ text, usage: { seconds: 4.2, cost: 0.0007 } }), { headers: { 'Content-Type': 'application/json' } });
  });
  return { seen, client };
};
const voice = (bytes = 4000, type = 'audio/webm;codecs=opus') => ({ mediaType: type, dataUrl: `data:${type};base64,${Buffer.alloc(bytes, 7).toString('base64')}` });

test('chat and transcription reserve concurrency before awaiting the daily budget', async () => {
  for (const route of ['chat', 'transcribe']) {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const database = { ...db, reserveDailyRequest: async (max: number) => { enter(); await gate; return db.reserveDailyRequest(max); } };
    const client = route === 'chat' ? replying().client : transcribing().client;
    const app = createApp({ ...config, MAX_CONCURRENT_REQUESTS: 1 }, database, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
    const token = await newSession(app);
    const transcription = () => new Request('http://localhost/v1/transcribe', { method: 'POST', body: JSON.stringify(voice()), headers: { 'Content-Type': 'application/json', Origin: config.SITE_ORIGIN, Authorization: `Bearer ${token}` } });
    const first = app.fetch(route === 'chat' ? ask(token) : transcription());
    await entered;
    try {
      assert.equal((await app.fetch(ask(token))).status, 429);
      assert.equal((await app.fetch(transcription())).status, 429);
    } finally { release(); }
    const response = await first;
    assert.equal(response.status, 200);
    await response.text();
    const next = await app.fetch(route === 'chat' ? ask(token) : transcription());
    assert.equal(next.status, 200, 'completion releases the reserved capacity');
    await next.text();
  }
});

test('a voice note is transcribed through the configured model and only the text comes back', async () => {
  const { seen, client } = transcribing();
  const app = createApp({ ...config, OPENROUTER_TRANSCRIPTION_MODEL: 'openai/gpt-4o-transcribe' }, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  const token = await newSession(app);
  const response = await app.fetch(new Request('http://localhost/v1/transcribe', {
    method: 'POST', body: JSON.stringify(voice()),
    headers: { 'Content-Type': 'application/json', Origin: config.SITE_ORIGIN, Authorization: `Bearer ${token}` },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'What makes HyprFM interesting?', model: 'openai/gpt-4o-transcribe', seconds: 4.2, costUsd: 0.0007 });
  assert.match(seen.url!, /\/audio\/transcriptions$/);
  assert.equal(seen.model, 'openai/gpt-4o-transcribe');
  // The codec suffix is dropped and the container names the file, which is how the provider picks the decoder.
  assert.equal(seen.filename, 'voice.webm');
  assert.equal(seen.bytes, 4000);
  // A transcription spends the same daily budget as an answer.
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM usage_daily')).rows[0].n, 1);
});

test('a bogus or oversized voice note is refused before the provider is called', async () => {
  let calls = 0;
  const app = createApp({ ...config, TRANSCRIPTION_MAX_BYTES: 100_000 }, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), mockClient(async () => { calls++; return new Response('{}'); }));
  const token = await newSession(app);
  const post = (body: unknown) => app.fetch(new Request('http://localhost/v1/transcribe', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: config.SITE_ORIGIN, Authorization: `Bearer ${token}` },
  }));
  assert.equal((await post({ mediaType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' })).status, 400);
  assert.equal((await post({ mediaType: 'audio/webm', dataUrl: 'https://evil.example/x.webm' })).status, 400);
  assert.equal((await post({ mediaType: 'audio/x-midi', dataUrl: voice(4000, 'audio/x-midi').dataUrl })).status, 400);
  assert.equal((await post(voice(200))).status, 400);
  assert.equal((await post(voice(150_000))).status, 413);
  assert.equal(calls, 0);
  const anonymous = await app.fetch(new Request('http://localhost/v1/transcribe', { method: 'POST', body: JSON.stringify(voice()), headers: { 'Content-Type': 'application/json', Origin: config.SITE_ORIGIN } }));
  assert.equal(anonymous.status, 401);
});

test('a provider failure on a voice note is reported without crashing the turn', async () => {
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), mockClient(async () => new Response('{"error":{"message":"upstream down"}}', { status: 500, headers: { 'Content-Type': 'application/json' } })));
  const token = await newSession(app);
  const response = await app.fetch(new Request('http://localhost/v1/transcribe', {
    method: 'POST', body: JSON.stringify(voice()),
    headers: { 'Content-Type': 'application/json', Origin: config.SITE_ORIGIN, Authorization: `Bearer ${token}` },
  }));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /could not be transcribed/);
});
