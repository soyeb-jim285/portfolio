import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app';
import { AmbiguousDeliveryError } from './mailer';
import { config, db, pool, fakeRetrieval, sentMail, fakeMailer, fakeStorage, fakeScheduler, sse, ask, newSession, scripted, events, draftCall } from './test-app-helpers';

const post = (app: ReturnType<typeof createApp>, body: unknown, token?: string) => app.fetch(new Request('http://localhost/v1/contact', {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', Origin: config.SITE_ORIGIN, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
}));

test('the assistant can only draft a message; sending is the visitor posting the text they saw', async () => {
  const { sent, client } = scripted(draftCall('{"name":"Ada","email":"ada@example.com","message":"I am hiring for Qt work."}'), sse('Here is a draft. Press Send when it looks right.'));
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  const token = await newSession(app);
  const frames = events(await (await app.fetch(ask(token, 'I want to message Jim'))).text());

  const draft = frames.find(event => event.type === 'draft').draft;
  assert.deepEqual({ ...draft, id: undefined }, { id: undefined, name: 'Ada', email: 'ada@example.com', message: 'I am hiring for Qt work.', to: 'Jim' });
  assert.match(sent[1].messages.at(-1).content, /you cannot send it/);
  // No tool can deliver mail: the model's only contact tool is the draft.
  assert.equal(sent[0].tools.some((tool: any) => /send/.test(tool.function.name)), false);
  assert.deepEqual(sentMail, []);
  assert.equal((await pool.query('SELECT status FROM contact_drafts WHERE id = $1', [draft.id])).rows[0].status, 'draft');

  // The visitor edits the text before sending; what they post is what is delivered.
  const response = await post(app, { draftId: draft.id, name: 'Ada Lovelace', email: 'ada@example.com', message: 'I am hiring for Qt and C++ work.' }, token);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { id: draft.id, status: 'accepted' });
  assert.deepEqual(sentMail, [{ name: 'Ada Lovelace', email: 'ada@example.com', body: 'I am hiring for Qt and C++ work.' }]);
  const stored = (await pool.query('SELECT status, name, message, provider_id FROM contact_drafts WHERE id = $1', [draft.id])).rows[0];
  assert.equal(stored.status, 'sent');
  assert.equal(stored.name, 'Ada Lovelace');
  assert.equal(stored.provider_id, 'mail_1');
});

test('a draft belongs to its session, and posting it twice never sends twice', async () => {
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), scripted(draftCall('{"name":"Ada","email":"ada@example.com","message":"Hello there Jim."}'), sse('Draft ready.')).client);
  const token = await newSession(app);
  const draft = events(await (await app.fetch(ask(token, 'message him'))).text()).find(event => event.type === 'draft').draft;
  const body = { draftId: draft.id, name: 'Ada', email: 'ada@example.com', message: 'Hello there Jim.' };

  const otherToken = await newSession(app);
  assert.equal((await post(app, body, otherToken)).status, 404, 'another session must not send this draft');
  assert.equal((await post(app, body)).status, 401, 'a draft cannot be sent without its session');
  assert.deepEqual(sentMail, []);

  assert.equal((await post(app, body, token)).status, 202);
  const again = await post(app, body, token);
  assert.equal(again.status, 202);
  assert.deepEqual(await again.json(), { id: draft.id, status: 'already-sent' });
  assert.equal(sentMail.length, 1, 'a retry must not deliver a second copy');
  assert.equal((await pool.query('SELECT contact_sends FROM usage_daily')).rows[0].contact_sends, 1);
});

test('the plain contact form uses the same delivery path', async () => {
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler());
  const response = await post(app, { name: 'Grace', email: 'grace@example.com', message: 'Question about hyprfm packaging.' });
  assert.equal(response.status, 202);
  assert.deepEqual(sentMail, [{ name: 'Grace', email: 'grace@example.com', body: 'Question about hyprfm packaging.' }]);
  assert.equal((await pool.query('SELECT session_id, status FROM contact_drafts')).rows[0].session_id, null);
});

test('rejects invalid messages, bots and disallowed origins before the provider', async () => {
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler());
  assert.equal((await post(app, { name: '', email: 'a@b.co', message: 'A long enough message.' })).status, 400);
  assert.equal((await post(app, { name: 'Ada', email: 'not-an-email', message: 'A long enough message.' })).status, 400);
  assert.equal((await post(app, { name: 'Ada', email: 'a@b.co', message: 'short' })).status, 400);
  assert.equal((await post(app, { name: 'Ada', email: 'a@b.co', message: 'A long enough message.', extra: 'x' })).status, 400);
  const wrongOrigin = await app.fetch(new Request('http://localhost/v1/contact', {
    method: 'POST', body: JSON.stringify({ name: 'Ada', email: 'a@b.co', message: 'A long enough message.' }),
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
  }));
  assert.equal(wrongOrigin.status, 403);
  // The honeypot is accepted silently so a bot cannot tell it was caught.
  assert.equal((await post(app, { name: 'Bot', email: 'bot@example.com', message: 'Cheap backlinks for you.', _gotcha: 'filled' })).status, 202);
  assert.deepEqual(sentMail, []);
});

test('send limits are enforced per address and per day', async () => {
  const app = createApp({ ...config, CONTACT_SENDS_PER_HOUR: 2 }, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler());
  const body = (n: number) => ({ name: `Visitor ${n}`, email: `v${n}@example.com`, message: `Message number ${n} for Jim.` });
  assert.equal((await post(app, body(1))).status, 202);
  assert.equal((await post(app, body(2))).status, 202);
  assert.equal((await post(app, body(3))).status, 429);
  assert.equal(sentMail.length, 2);

  const capped = createApp({ ...config, CONTACT_SENDS_PER_DAY: 2 }, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler());
  assert.equal((await post(capped, body(4))).status, 429, 'the daily cap is shared across processes');
});

test('a provider failure keeps the draft, frees the slot and can be retried', async () => {
  let failNext = true;
  const mailer = fakeMailer({ async send(message) { if (failNext) throw new Error('provider down'); sentMail.push(message); return 'mail_retry'; } });
  const app = createApp(config, db, fakeRetrieval(), mailer, fakeStorage(), fakeScheduler(), scripted(draftCall('{"name":"Ada","email":"ada@example.com","message":"Please get in touch."}'), sse('Draft ready.')).client);
  const token = await newSession(app);
  const draft = events(await (await app.fetch(ask(token, 'message him'))).text()).find(event => event.type === 'draft').draft;
  const body = { draftId: draft.id, name: 'Ada', email: 'ada@example.com', message: 'Please get in touch.' };

  const failure = await post(app, body, token);
  assert.equal(failure.status, 502);
  assert.doesNotMatch(JSON.stringify(await failure.json()), /provider down/);
  assert.equal((await pool.query('SELECT status FROM contact_drafts WHERE id = $1', [draft.id])).rows[0].status, 'failed');
  assert.equal((await pool.query('SELECT contact_sends FROM usage_daily')).rows[0].contact_sends, 0, 'a failed send must not spend the budget');

  failNext = false;
  assert.equal((await post(app, body, token)).status, 202);
  assert.equal(sentMail.length, 1);
});

test('ambiguous mail delivery and persistence failures cannot trigger duplicate sends', async () => {
  for (const ambiguous of [true, false]) {
    let sends = 0;
    const { token } = await db.createSession();
    const sessionId = (await db.touchSession(token))!;
    const draft = { name: 'Ada', email: 'ada@example.com', message: 'Please get in touch.' };
    const draftId = await db.createDraft(sessionId, draft, 60);
    const database = ambiguous ? db : { ...db, finishDraft: async () => { throw new Error('write failed after send'); } };
    const mailer = fakeMailer({ send: async () => { sends++; if (ambiguous) throw new AmbiguousDeliveryError('no confirmation'); return 'accepted'; } });
    const app = createApp(config, database, fakeRetrieval(), mailer, fakeStorage(), fakeScheduler());
    assert.equal((await post(app, { ...draft, draftId }, token)).status, ambiguous ? 502 : 500);
    assert.equal((await post(app, { ...draft, draftId }, token)).status, 502);
    assert.equal(sends, 1);
  }
});

test('with no mail provider configured nothing is offered and nothing is sent', async () => {
  const offline = { configured: false, recipientLabel: 'Jim', send: async () => { throw new Error('not configured'); } };
  const { sent, client } = scripted(draftCall('{"name":"Ada","email":"ada@example.com","message":"Hello there."}'), sse('Use the contact page.'));
  const app = createApp(config, db, fakeRetrieval(), offline, fakeStorage(), fakeScheduler(), client);
  const token = await newSession(app);
  const frames = events(await (await app.fetch(ask(token, 'message him'))).text());
  assert.equal(frames.some(event => event.type === 'draft'), false);
  assert.match(sent[1].messages.at(-1).content, /not configured/);
  assert.match(sent[0].messages[0].content, /Message delivery is switched off/);
  assert.equal((await post(app, { name: 'Ada', email: 'a@b.co', message: 'A long enough message.' })).status, 503);
});

test('expired drafts are swept and can no longer be sent', async () => {
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), scripted(draftCall('{"name":"Ada","email":"ada@example.com","message":"Time sensitive note."}'), sse('Draft ready.')).client);
  const token = await newSession(app);
  const draft = events(await (await app.fetch(ask(token, 'message him'))).text()).find(event => event.type === 'draft').draft;
  await pool.query(`UPDATE contact_drafts SET expires_at = now() - interval '1 minute'`);
  assert.equal((await post(app, { draftId: draft.id, name: 'Ada', email: 'ada@example.com', message: 'Time sensitive note.' }, token)).status, 404);
  await db.sweep();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM contact_drafts')).rows[0].n, 0);
  assert.deepEqual(sentMail, []);
});
