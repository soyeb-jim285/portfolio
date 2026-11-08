import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app';
import { config, db, fakeRetrieval, sentMail, fakeMailer, fakeStorage, fakeScheduler } from './test-app-helpers';

// Turnstile is checked against Cloudflare over fetch; the tests stand in for siteverify.
const withSiteverify = async (reply: (body: URLSearchParams) => Response | Promise<Response>, run: (calls: URLSearchParams[]) => Promise<void>) => {
  const real = globalThis.fetch;
  const calls: URLSearchParams[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const body = new URLSearchParams(String(init?.body));
    calls.push(body);
    return reply(body);
  }) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch = real; }
};
const guarded = { ...config, TURNSTILE_SECRET_KEY: 'test-secret' };
const startWith = (app: ReturnType<typeof createApp>, token?: string) => app.fetch(new Request('http://localhost/v1/sessions', {
  method: 'POST', headers: { Origin: config.SITE_ORIGIN, ...(token ? { 'X-Turnstile-Token': token } : {}) },
}));

// What siteverify says about a genuine token minted on this site for this purpose.
const vouch = (body: URLSearchParams, action: string) => Response.json(body.get('response') === 'good-token'
  ? { success: true, action, hostname: new URL(config.SITE_ORIGIN).hostname }
  : { success: false, 'error-codes': ['invalid-input-response'] });

test('with a Turnstile secret, a conversation starts only after Cloudflare vouches for the visitor', async () => {
  const app = createApp(guarded, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler());
  await withSiteverify(body => vouch(body, 'session'), async calls => {
    assert.equal((await startWith(app)).status, 403, 'no token');
    assert.equal(calls.length, 0, 'a missing token never reaches Cloudflare');
    assert.equal((await startWith(app, 'forged')).status, 403, 'rejected token');
    const started = await startWith(app, 'good-token');
    assert.equal(started.status, 201);
    assert.ok((await started.json()).token);
    assert.equal(calls.at(-1)?.get('secret'), 'test-secret');
  });
});

test('a genuine token is refused when it was minted for the other form or on another site', async () => {
  const app = createApp(guarded, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler());
  await withSiteverify(() => Response.json({ success: true, action: 'contact', hostname: new URL(config.SITE_ORIGIN).hostname }), async () => {
    assert.equal((await startWith(app, 'good-token')).status, 403, 'contact token spent on a session');
  });
  await withSiteverify(() => Response.json({ success: true, action: 'session', hostname: 'evil.example' }), async () => {
    assert.equal((await startWith(app, 'good-token')).status, 403, 'token from another hostname');
  });
  // Cloudflare's always-pass test secret reports a dummy page, so it skips both checks for local work.
  const testing = createApp({ ...config, TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler());
  await withSiteverify(() => Response.json({ success: true, action: '', hostname: 'example.com' }), async () => {
    assert.equal((await startWith(testing, 'XXXX.DUMMY.TOKEN.XXXX')).status, 201);
  });
});

test('an unreachable Turnstile fails closed rather than letting everyone through', async () => {
  const app = createApp(guarded, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler());
  await withSiteverify(() => { throw new TypeError('network down'); }, async () => {
    assert.equal((await startWith(app, 'any-token')).status, 503);
  });
  await withSiteverify(() => new Response('bad gateway', { status: 502 }), async () => {
    assert.equal((await startWith(app, 'any-token')).status, 503);
  });
});

test('the direct contact form needs a Turnstile token; without a secret the check is off', async () => {
  const letter = { name: 'Ada', email: 'ada@example.com', message: 'I am hiring for Qt work.' };
  const directPost = (app: ReturnType<typeof createApp>, token?: string) => app.fetch(new Request('http://localhost/v1/contact', {
    method: 'POST', body: JSON.stringify(letter),
    headers: { 'Content-Type': 'application/json', Origin: config.SITE_ORIGIN, ...(token ? { 'X-Turnstile-Token': token } : {}) },
  }));
  const guardedApp = createApp(guarded, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler());
  const before = sentMail.length;
  await withSiteverify(body => vouch(body, 'contact'), async () => {
    assert.equal((await directPost(guardedApp)).status, 403);
    assert.equal(sentMail.length, before, 'a failed check sends nothing');
    assert.equal((await directPost(guardedApp, 'good-token')).status, 202);
  });
  const openApp = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler());
  assert.equal((await directPost(openApp)).status, 202, 'no secret configured, no check');
});
