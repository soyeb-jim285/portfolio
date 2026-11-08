import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app';
import { AmbiguousBookingError } from './scheduler';
import { config, db, pool, fakeRetrieval, fakeMailer, fakeStorage, slotAt, booked, fakeScheduler, sse, ask, newSession, scripted, events, availabilityCall, proposeCall, confirmRequest, askInZone } from './test-app-helpers';

test('a proposal must match a real slot, and the visitor confirms it', async () => {
  const start = slotAt(24).start;
  const { sent, client } = scripted(proposeCall(start), sse('Confirm when the time suits you.'));
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  const token = await newSession(app);
  const frames = events(await (await app.fetch(askInZone(token, 'Book me in', 'Europe/Rome'))).text());

  const proposal = frames.find(event => event.type === 'proposal').proposal;
  assert.equal(proposal.start, start);
  assert.equal(proposal.timeZone, 'Europe/Rome');
  assert.equal(proposal.durationMinutes, 30);
  assert.equal(new Date(proposal.end).getTime() - new Date(proposal.start).getTime(), 1800000);
  assert.match(sent[1].messages.at(-1).content, /You cannot book/);
  assert.equal(booked.length, 0, 'proposing must not book');
  assert.equal((await pool.query('SELECT status FROM bookings WHERE id = $1', [proposal.id])).rows[0].status, 'pending');

  const response = await confirmRequest(app, token, { proposalId: proposal.id, start, name: 'Ada Lovelace', email: 'ada@example.com', timeZone: 'Europe/Rome' });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: proposal.id, uid: 'event_1', start, status: 'confirmed' });
  assert.deepEqual(booked, [{ eventTypeKey: '30min', start, name: 'Ada Lovelace', email: 'ada@example.com', timeZone: 'Europe/Rome' }]);
  const row = (await pool.query('SELECT status, provider_uid, name FROM bookings WHERE id = $1', [proposal.id])).rows[0];
  assert.equal(row.status, 'confirmed');
  assert.equal(row.provider_uid, 'event_1');
  assert.equal(row.name, 'Ada Lovelace');
});

test('calendar tools share a lookup within a turn but confirmation always reads live availability', async () => {
  let lookups = 0;
  const start = slotAt(24).start;
  const scheduler = fakeScheduler({ availability: async () => { lookups++; return [slotAt(24)]; } });
  const { client } = scripted(availabilityCall, proposeCall(start), sse('Confirm the time below.'));
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), scheduler, client);
  const token = await newSession(app);
  const frames = events(await (await app.fetch(ask(token, 'Find a time and propose it'))).text());
  assert.equal(lookups, 1);
  const proposal = frames.find(event => event.type === 'proposal').proposal;
  assert.equal((await confirmRequest(app, token, { proposalId: proposal.id, start, name: 'Ada', email: 'ada@example.com', timeZone: 'UTC' })).status, 201);
  assert.equal(lookups, 2);
});

test('a persistence failure after a calendar acceptance never permits a second booking', async () => {
  const { token } = await db.createSession();
  const sessionId = (await db.touchSession(token))!;
  const start = slotAt(24).start;
  const id = await db.createBooking({ sessionId, meetingKey: '30min', slotStart: start, name: 'Ada', email: 'ada@example.com', timeZone: 'UTC', notes: '' }, 60);
  const database = { ...db, finishBooking: async () => { throw new Error('write failed after booking'); } };
  const app = createApp(config, database, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler());
  const body = { proposalId: id, start, name: 'Ada', email: 'ada@example.com', timeZone: 'UTC' };
  assert.equal((await confirmRequest(app, token, body)).status, 500);
  assert.equal((await confirmRequest(app, token, body)).status, 404);
  assert.equal(booked.length, 1);
});

test('a time that is no longer free is refused with the current slots', async () => {
  const start = slotAt(24).start;
  const scheduler = fakeScheduler();
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), scheduler, scripted(proposeCall(start), sse('Confirm below.')).client);
  const token = await newSession(app);
  const proposal = events(await (await app.fetch(ask(token, 'book me'))).text()).find(event => event.type === 'proposal').proposal;

  scheduler.availability = async () => [slotAt(26)];
  const response = await confirmRequest(app, token, { proposalId: proposal.id, start, name: 'Ada', email: 'ada@example.com', timeZone: 'UTC' });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error, /taken while you were deciding/);
  assert.deepEqual(body.slots.map((slot: any) => slot.start), [slotAt(26).start]);
  assert.equal(booked.length, 0);
  assert.equal((await pool.query('SELECT status FROM bookings WHERE id = $1', [proposal.id])).rows[0].status, 'conflict');
});

test('a proposal is bound to its session and confirming twice books once', async () => {
  const start = slotAt(24).start;
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), scripted(proposeCall(start), sse('Confirm below.')).client);
  const token = await newSession(app);
  const proposal = events(await (await app.fetch(ask(token, 'book me'))).text()).find(event => event.type === 'proposal').proposal;
  const body = { proposalId: proposal.id, start, name: 'Ada', email: 'ada@example.com', timeZone: 'UTC' };

  const otherToken = await newSession(app);
  assert.equal((await confirmRequest(app, otherToken, body)).status, 404, 'another session must not confirm this call');
  assert.equal(booked.length, 0);

  assert.equal((await confirmRequest(app, token, body)).status, 201);
  const again = await confirmRequest(app, token, body);
  assert.equal(again.status, 201);
  assert.deepEqual(await again.json(), { id: proposal.id, uid: 'event_1', start, status: 'already-booked' });
  assert.equal(booked.length, 1, 'a retry must not create a second booking');
  assert.equal((await pool.query('SELECT bookings FROM usage_daily')).rows[0].bookings, 1);
});

test('an unanswered provider leaves the booking unresolved and refuses to retry it', async () => {
  const start = slotAt(24).start;
  const scheduler = fakeScheduler({ book: async () => { throw new AmbiguousBookingError('socket hang up'); } });
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), scheduler, scripted(proposeCall(start), sse('Confirm below.')).client);
  const token = await newSession(app);
  const proposal = events(await (await app.fetch(ask(token, 'book me'))).text()).find(event => event.type === 'proposal').proposal;
  const body = { proposalId: proposal.id, start, name: 'Ada', email: 'ada@example.com', timeZone: 'UTC' };

  const response = await confirmRequest(app, token, body);
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /Check your email before booking again/);
  assert.equal((await pool.query('SELECT status FROM bookings WHERE id = $1', [proposal.id])).rows[0].status, 'unknown');
  const retry = await confirmRequest(app, token, body);
  assert.equal(retry.status, 504, 'a maybe-booked call is never silently retried');
});

test('a rejected booking frees the slot budget and can be tried again', async () => {
  const start = slotAt(24).start;
  let reject = true;
  const scheduler = fakeScheduler({ book: async input => { if (reject) throw new Error('Booking rejected (400)'); booked.push({ eventTypeKey: input.eventTypeKey, start: input.start, name: input.name, email: input.email, timeZone: input.timeZone }); return { uid: 'event_ok' }; } });
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), scheduler, scripted(proposeCall(start), sse('Confirm below.')).client);
  const token = await newSession(app);
  const proposal = events(await (await app.fetch(ask(token, 'book me'))).text()).find(event => event.type === 'proposal').proposal;
  const body = { proposalId: proposal.id, start, name: 'Ada', email: 'ada@example.com', timeZone: 'UTC' };

  const failure = await confirmRequest(app, token, body);
  assert.equal(failure.status, 502);
  assert.doesNotMatch(JSON.stringify(await failure.json()), /400/);
  assert.equal((await pool.query('SELECT bookings FROM usage_daily')).rows[0].bookings, 0);
  reject = false;
  assert.equal((await confirmRequest(app, token, body)).status, 201);
  assert.equal(booked.length, 1);
});

test('the daily booking cap is shared and expired proposals are swept', async () => {
  const start = slotAt(24).start;
  const capped = { ...config, BOOKINGS_PER_DAY: 1 };
  const app = createApp(capped, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), scripted(proposeCall(start), sse('Confirm below.')).client);
  const token = await newSession(app);
  const first = events(await (await app.fetch(ask(token, 'book me'))).text()).find(event => event.type === 'proposal').proposal;
  assert.equal((await confirmRequest(app, token, { proposalId: first.id, start, name: 'Ada', email: 'ada@example.com', timeZone: 'UTC' })).status, 201);

  // A second process against the same database: the cap is shared, not per instance.
  const other = createApp(capped, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), scripted(proposeCall(start), sse('Confirm below.')).client);
  const second = events(await (await other.fetch(ask(token, 'book me again'))).text()).find(event => event.type === 'proposal').proposal;
  const capReached = await confirmRequest(other, token, { proposalId: second.id, start, name: 'Ada', email: 'ada@example.com', timeZone: 'UTC' });
  assert.equal(capReached.status, 429);
  assert.equal(booked.length, 1);

  await pool.query(`UPDATE bookings SET status = 'pending', expires_at = now() - interval '1 minute' WHERE id = $1`, [second.id]);
  await db.sweep();
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings WHERE id = $1', [second.id])).rows[0].n, 0);
});
