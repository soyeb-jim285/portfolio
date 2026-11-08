import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app';
import { config, db, pool, fakeRetrieval, fakeMailer, fakeStorage, slotAt, fakeScheduler, sse, mockClient, replying, ask, newSession } from './test-app-helpers';

test('rejects unknown, forged and expired session tokens before calling the model', async () => {
  let calls = 0;
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), mockClient(async () => { calls++; return new Response(sse('ok')); }));
  const token = await newSession(app);
  for (const bad of [undefined, 'not-a-token', `${token}x`, token.slice(0, -1)]) assert.equal((await app.fetch(ask(bad))).status, 401);
  await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute'`);
  assert.equal((await app.fetch(ask(token))).status, 401);
  assert.equal(calls, 0);
});

test('expired sessions are swept', async () => {
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), replying().client);
  const token = await newSession(app);
  await (await app.fetch(ask(token, 'Left to expire'))).text();
  await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 day'`);
  assert.equal(await db.sweep(), 1);
  assert.equal((await app.fetch(ask(token))).status, 401);
});

test('concurrent claims cannot send one draft or confirm one proposal twice', async () => {
  const { token } = await db.createSession();
  const sessionId = (await db.touchSession(token))!;
  const draft = { name: 'Ada', email: 'ada@example.com', message: 'Please get in touch.' };
  const draftId = await db.createDraft(sessionId, draft, 60);
  const drafts = await Promise.all(Array.from({ length: 8 }, () => db.claimDraft(draftId, sessionId, draft)));
  assert.equal(drafts.filter(result => result.claimed).length, 1);
  const booking = { sessionId, meetingKey: '30min', slotStart: slotAt(24).start, name: draft.name, email: draft.email, timeZone: 'UTC', notes: '' };
  const bookingId = await db.createBooking(booking, 60);
  const bookings = await Promise.all(Array.from({ length: 8 }, () => db.claimBooking(bookingId, sessionId, booking)));
  assert.equal(bookings.filter(result => result.claimed).length, 1);
  const release = await db.acquireBookingLock();
  assert.ok(release);
  assert.equal(await db.acquireBookingLock(), null, 'the check/create lock is shared by separate DB connections');
  await release();
  const again = await db.acquireBookingLock();
  assert.ok(again);
  await again();
});
