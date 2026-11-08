import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app';
import type { Storage } from './storage';
import { config, cachedConfig, db, pool, fakeRetrieval, fakeMailer, stored, fakeStorage, fakeScheduler, sse, ask, newSession, toolFrame, scripted, events } from './test-app-helpers';

const artifactCall = (args: string) => toolFrame([{ index: 0, id: 'call_doc', name: 'create_artifact', args }], 'tool_calls') + 'data: [DONE]\n\n';
const brief = JSON.stringify({ kind: 'brief', title: 'HyprFM transfer architecture', markdown: 'Transfers run on a worker thread.\n\nEvidence: hyprfm/src/services/fileoperations.cpp:2641-2700.\n\nInferred: the queue depth is not visible in the code I read.' });

test('reserves document creation after the research budget is exhausted', async () => {
  const research = toolFrame([{ index: 0, id: 'call_search', name: 'search_knowledge', args: '{"query":"transfers"}' }], 'tool_calls') + 'data: [DONE]\n\n';
  const { sent, client } = scripted(research, artifactCall(brief), sse('Use Download Markdown on the document card.'));
  const app = createApp({ ...config, MAX_TOOL_STEPS: 1 }, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  const token = await newSession(app);
  const frames = events(await (await app.fetch(ask(token, 'Create a downloadable technical brief about HyprFM'))).text());
  assert.deepEqual(sent[1].tools.map((tool: any) => tool.function.name), ['create_artifact']);
  assert.match(sent[1].messages.at(-1).content, /create it now from the evidence/);
  assert.ok(!sent[2].tools);
  const artifacts = frames.filter(event => event.type === 'artifact');
  assert.equal(artifacts.length, 1);
  const download = await app.fetch(new Request(`http://localhost/v1/artifacts/${artifacts[0].artifact.id}`, { headers: { Origin: config.SITE_ORIGIN, Authorization: `Bearer ${token}` } }));
  assert.equal(download.status, 200);
  assert.equal(frames.at(-1).type, 'done');
});

test('generates a document, stores it privately and hands out a short-lived link to its own session', async () => {
  const { sent, client } = scripted(artifactCall(brief), sse('I wrote you a one-page brief.'));
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  const token = await newSession(app);
  const frames = events(await (await app.fetch(ask(token, 'Give me a brief I can keep'))).text());

  const artifact = frames.find(event => event.type === 'artifact').artifact;
  assert.equal(artifact.kind, 'brief');
  assert.equal(artifact.title, 'HyprFM transfer architecture');
  assert.match(artifact.markdown, /^# HyprFM transfer architecture/);
  assert.match(artifact.markdown, /fileoperations\.cpp:2641-2700/);
  assert.match(sent[1].messages.at(-1).content, /do not repeat it in full/);

  const row = (await pool.query('SELECT session_id, object_key, bytes FROM artifacts WHERE id = $1', [artifact.id])).rows[0];
  assert.match(row.object_key, new RegExp(`^artifacts/[0-9a-f-]{36}/${artifact.id}\\.md$`), 'the key is built from server ids only');
  assert.equal(stored.get(row.object_key), artifact.markdown);
  assert.equal(row.bytes, Buffer.byteLength(artifact.markdown, 'utf8'));

  const link = await app.fetch(new Request(`http://localhost/v1/artifacts/${artifact.id}`, { headers: { Origin: config.SITE_ORIGIN, Authorization: `Bearer ${token}` } }));
  assert.equal(link.status, 200);
  const body = await link.json();
  assert.match(body.url, /X-Amz-Expires=120&X-Amz-Signature=/);
  assert.equal(body.title, artifact.title);

  const otherToken = await newSession(app);
  const forbidden = await app.fetch(new Request(`http://localhost/v1/artifacts/${artifact.id}`, { headers: { Origin: config.SITE_ORIGIN, Authorization: `Bearer ${otherToken}` } }));
  assert.equal(forbidden.status, 404, 'another session must not get a link');
  const anonymous = await app.fetch(new Request(`http://localhost/v1/artifacts/${artifact.id}`, { headers: { Origin: config.SITE_ORIGIN } }));
  assert.equal(anonymous.status, 401);
});

test('refuses documents with HTML, scripts, oversized bodies or a diagram without a diagram', async () => {
  const cases = [
    [JSON.stringify({ kind: 'brief', title: 'Injected', markdown: 'Hello <script>fetch("//evil")</script> world, with enough text to pass the minimum length.' }), /HTML or a script-like URL/],
    [JSON.stringify({ kind: 'brief', title: 'Injected', markdown: '[click me](javascript:alert(1)) and some more words to pass the minimum length check.' }), /HTML or a script-like URL/],
    [JSON.stringify({ kind: 'brief', title: 'Injected', markdown: `<img src=x onerror="alert(1)"> and some more words to pass the minimum length check.` }), /HTML or a script-like URL/],
    [JSON.stringify({ kind: 'brief', title: 'Huge', markdown: 'x'.repeat(70000) }), /exceeds 64000 bytes/],
    [JSON.stringify({ kind: 'diagram', title: 'No diagram', markdown: 'This claims to be a diagram but contains no mermaid block at all, just prose.' }), /must contain a ```mermaid/],
    [JSON.stringify({ kind: 'poster', title: 'Wrong kind', markdown: 'A kind that is not on the list, with enough text to pass the minimum length.' }), /Invalid artifact/],
  ] as const;
  for (const [args, expected] of cases) {
    await pool.query('TRUNCATE sessions, usage_daily CASCADE');
    stored.clear();
    const { sent, client } = scripted(artifactCall(args), sse('I cannot produce that document.'));
    const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
    const token = await newSession(app);
    const frames = events(await (await app.fetch(ask(token, 'make a document'))).text());
    assert.equal(frames.some(event => event.type === 'artifact'), false);
    assert.match(sent[1].messages.at(-1).content, expected);
    assert.equal(stored.size, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM artifacts')).rows[0].n, 0);
  }
});

test('a storage failure is reported and stores no row', async () => {
  const failing = fakeStorage({ put: async () => { throw new Error('bucket unreachable'); } });
  const { sent, client } = scripted(artifactCall(brief), sse('The document could not be produced.'));
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), failing, fakeScheduler(), client);
  const token = await newSession(app);
  const frames = events(await (await app.fetch(ask(token, 'make a brief'))).text());
  assert.equal(frames.some(event => event.type === 'artifact'), false);
  assert.match(sent[1].messages.at(-1).content, /could not be stored/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM artifacts')).rows[0].n, 0);
  assert.equal(frames.at(-1).type, 'done');
});

test('an uploaded document is removed if its ownership row cannot be saved, and the failure is not cached', async () => {
  const database = { ...db, createArtifact: async () => { throw new Error('database unavailable'); } };
  const { client } = scripted(artifactCall(brief), sse('The document could not be stored.'));
  const app = createApp(cachedConfig, database, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  const frames = events(await (await app.fetch(ask(await newSession(app), 'Create a downloadable brief'))).text());
  assert.equal(stored.size, 0);
  assert.equal(frames.some(event => event.type === 'artifact'), false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM answer_cache')).rows[0].n, 0);
});

test('with no storage configured the tool is refused and downloads answer 503', async () => {
  const offline: Storage = { configured: false, put: async () => { throw new Error('off'); }, signedUrl: async () => { throw new Error('off'); }, remove: async () => {} };
  const { sent, client } = scripted(artifactCall(brief), sse('I cannot produce documents right now.'));
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), offline, fakeScheduler(), client);
  const token = await newSession(app);
  const frames = events(await (await app.fetch(ask(token, 'make a brief'))).text());
  assert.equal(frames.some(event => event.type === 'artifact'), false);
  assert.match(sent[1].messages.at(-1).content, /storage is not configured/);
  assert.doesNotMatch(sent[0].messages[0].content, /create_artifact when the visitor asks/);
  const link = await app.fetch(new Request(`http://localhost/v1/artifacts/${crypto.randomUUID()}`, { headers: { Origin: config.SITE_ORIGIN, Authorization: `Bearer ${token}` } }));
  assert.equal(link.status, 503);
});

test('expired artifacts stop resolving and their objects are deleted with their rows', async () => {
  const storage = fakeStorage();
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), storage, fakeScheduler(), scripted(artifactCall(brief), sse('Brief ready.')).client);
  const token = await newSession(app);
  const artifact = events(await (await app.fetch(ask(token, 'make a brief'))).text()).find(event => event.type === 'artifact').artifact;
  const key = (await pool.query('SELECT object_key FROM artifacts WHERE id = $1', [artifact.id])).rows[0].object_key;

  await pool.query(`UPDATE artifacts SET expires_at = now() - interval '1 hour'`);
  const link = await app.fetch(new Request(`http://localhost/v1/artifacts/${artifact.id}`, { headers: { Origin: config.SITE_ORIGIN, Authorization: `Bearer ${token}` } }));
  assert.equal(link.status, 404);

  const expired = await db.expiredArtifacts();
  assert.deepEqual(expired.map(entry => entry.objectKey), [key]);
  await storage.remove(expired.map(entry => entry.objectKey));
  await db.deleteArtifacts(expired.map(entry => entry.id));
  assert.equal(stored.has(key), false, 'the object must not outlive its row');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM artifacts')).rows[0].n, 0);
});

test('expired sessions retain artifact ownership until object cleanup completes', async () => {
  const { token } = await db.createSession();
  const sessionId = (await db.touchSession(token))!;
  const id = crypto.randomUUID();
  await db.createArtifact({ id, sessionId, kind: 'brief', title: 'Brief', objectKey: 'test.md', bytes: 10, sources: [] }, 7);
  await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
  assert.deepEqual(await db.expiredArtifacts(), [{ id, objectKey: 'test.md' }]);
  assert.equal(await db.sweep(), 0, 'a storage outage must not orphan objects by deleting the owner');
  await db.deleteArtifacts([id]);
  assert.equal(await db.sweep(), 1);
});
