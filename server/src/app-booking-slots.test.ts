import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app';
import type { Scheduler } from './scheduler';
import { config, db, pool, fakeRetrieval, fakeMailer, fakeStorage, slotAt, booked, fakeScheduler, sse, ask, newSession, toolFrame, scripted, events, availabilityCall, confirmRequest, askInZone } from './test-app-helpers';

test('availability comes from the calendar, in the visitor time zone, and the model gets only real slots', async () => {
  const { sent, client } = scripted(availabilityCall, sse('Here are the free times.'));
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  const token = await newSession(app);
  const frames = events(await (await app.fetch(askInZone(token, 'When can we talk?', 'Asia/Dhaka'))).text());

  const availability = frames.find(event => event.type === 'slots').availability;
  assert.equal(availability.timeZone, 'Asia/Dhaka');
  assert.equal(availability.durationMinutes, 30);
  assert.equal(availability.label, 'Intro call');
  assert.equal(availability.key, '30min');
  assert.deepEqual(availability.slots.map((slot: any) => slot.start), [slotAt(24).start, slotAt(26).start]);
  const toolResult = sent[1].messages.at(-1).content;
  assert.match(toolResult, /never invent one/);
  assert.match(toolResult, /slots$/m, 'the model gets a per-day summary');
  assert.match(toolResult, new RegExp(slotAt(24).start));
  assert.equal(booked.length, 0);
});

test('an unreachable calendar is reported instead of invented', async () => {
  const broken = fakeScheduler({ availability: async () => { throw new Error('cal down'); } });
  const { sent, client } = scripted(availabilityCall, sse('I could not reach the calendar.'));
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), broken, client);
  const token = await newSession(app);
  const frames = events(await (await app.fetch(ask(token, 'When can we talk?'))).text());
  assert.equal(frames.some(event => event.type === 'slots'), false);
  assert.match(sent[1].messages.at(-1).content, /never guess at free times/);
});

test('with no calendar configured nothing is offered and confirmations answer 503', async () => {
  const offline: Scheduler = { configured: false, eventTypes: [], availability: async () => { throw new Error('off'); }, book: async () => { throw new Error('off'); } };
  const { sent, client } = scripted(availabilityCall, sse('Booking is unavailable.'));
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), offline, client);
  const token = await newSession(app);
  const frames = events(await (await app.fetch(ask(token, 'book a call'))).text());
  assert.equal(frames.some(event => event.type === 'slots'), false);
  assert.match(sent[1].messages.at(-1).content, /Scheduling is not configured/);
  assert.match(sent[0].messages[0].content, /never offer to book a call/);
  assert.equal(sent[0].tools.some((tool: any) => tool.function.name === 'get_availability'), true);
  const response = await confirmRequest(app, token, { proposalId: crypto.randomUUID(), start: slotAt(24).start, name: 'Ada', email: 'ada@example.com', timeZone: 'UTC' });
  assert.equal(response.status, 503);
});

test('each meeting length has its own availability and books its own event type', async () => {
  const shortCall = toolFrame([{ index: 0, id: 'call_15', name: 'get_availability', args: '{"duration":"15min"}' }], 'tool_calls') + 'data: [DONE]\n\n';
  const { sent, client } = scripted(shortCall, sse('Here are the short slots.'));
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  const token = await newSession(app);
  const availability = events(await (await app.fetch(ask(token, 'Can we do a quick chat?'))).text()).find(event => event.type === 'slots').availability;
  assert.deepEqual([availability.key, availability.durationMinutes, availability.label], ['15min', 15, 'Quick chat']);
  assert.deepEqual(availability.slots.map((slot: any) => slot.start), [slotAt(30).start]);
  assert.match(sent[1].messages.at(-1).content, /Quick chat \(15 minutes\)/);

  const propose15 = toolFrame([{ index: 0, id: 'call_p15', name: 'propose_booking', args: JSON.stringify({ start: slotAt(30).start, duration: '15min', name: 'Ada', email: 'ada@example.com' }) }], 'tool_calls') + 'data: [DONE]\n\n';
  const booking = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), scripted(propose15, sse('Confirm below.')).client);
  const proposal = events(await (await booking.fetch(ask(token, 'the 15 minute one'))).text()).find(event => event.type === 'proposal').proposal;
  assert.deepEqual([proposal.key, proposal.durationMinutes], ['15min', 15]);
  assert.equal(new Date(proposal.end).getTime() - new Date(proposal.start).getTime(), 900000);

  const response = await confirmRequest(booking, token, { proposalId: proposal.id, start: slotAt(30).start, name: 'Ada', email: 'ada@example.com', timeZone: 'UTC' });
  assert.equal(response.status, 201);
  assert.equal(booked.at(-1)!.eventTypeKey, '15min', 'the stored proposal decides the meeting length');
});

test('a slot from one meeting length cannot be proposed for another', async () => {
  const mismatch = toolFrame([{ index: 0, id: 'call_x', name: 'propose_booking', args: JSON.stringify({ start: slotAt(24).start, duration: '15min' }) }], 'tool_calls') + 'data: [DONE]\n\n';
  const { sent, client } = scripted(mismatch, sse('That time is not free for a quick chat.'));
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  const token = await newSession(app);
  const frames = events(await (await app.fetch(ask(token, 'book the wrong one'))).text());
  assert.equal(frames.some(event => event.type === 'proposal'), false);
  assert.match(sent[1].messages.at(-1).content, /not free for this meeting length/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 0);
});

test('an unknown meeting length is refused', async () => {
  const bad = toolFrame([{ index: 0, id: 'call_b', name: 'get_availability', args: '{"duration":"90min"}' }], 'tool_calls') + 'data: [DONE]\n\n';
  const { sent, client } = scripted(bad, sse('That length is not offered.'));
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler(), client);
  const token = await newSession(app);
  const frames = events(await (await app.fetch(ask(token, 'book 90 minutes'))).text());
  assert.equal(frames.some(event => event.type === 'slots'), false);
  assert.match(sent[1].messages.at(-1).content, /Choose one of: 30min, 15min/);
});

const proposeRequest = (app: ReturnType<typeof createApp>, token: string, body: unknown) => app.fetch(new Request('http://localhost/v1/proposals', {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', Origin: config.SITE_ORIGIN, Authorization: `Bearer ${token}` },
}));

test('picking a slot holds it for confirmation without the model proposing', async () => {
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler());
  const token = await newSession(app);
  const start = slotAt(30).start;

  const held = await proposeRequest(app, token, { start, key: '15min', timeZone: 'Asia/Dhaka' });
  assert.equal(held.status, 201);
  const proposal = await held.json();
  assert.deepEqual([proposal.key, proposal.durationMinutes, proposal.timeZone, proposal.name], ['15min', 15, 'Asia/Dhaka', '']);
  assert.equal(new Date(proposal.end).getTime() - new Date(proposal.start).getTime(), 900000);
  assert.equal(booked.length, 0, 'holding a slot must not book it');
  const row = (await pool.query('SELECT status, meeting_key FROM bookings WHERE id = $1', [proposal.id])).rows[0];
  assert.deepEqual([row.status, row.meeting_key], ['pending', '15min']);

  // The visitor then confirms it exactly as if the model had proposed it.
  const confirmed = await confirmRequest(app, token, { proposalId: proposal.id, start, name: 'Ada', email: 'ada@example.com', timeZone: 'Asia/Dhaka' });
  assert.equal(confirmed.status, 201);
  assert.equal(booked.at(-1)!.eventTypeKey, '15min');
});

test('a slot that is not free, or a meeting length that does not exist, cannot be held', async () => {
  const app = createApp(config, db, fakeRetrieval(), fakeMailer(), fakeStorage(), fakeScheduler());
  const token = await newSession(app);
  const taken = await proposeRequest(app, token, { start: slotAt(99).start, key: '30min', timeZone: 'UTC' });
  assert.equal(taken.status, 409);
  assert.ok((await taken.json()).slots.length, 'a conflict must return the current slots');
  assert.equal((await proposeRequest(app, token, { start: slotAt(24).start, key: '90min', timeZone: 'UTC' })).status, 404);
  assert.equal((await proposeRequest(app, token, { start: 'not-a-date', key: '30min', timeZone: 'UTC' })).status, 400);
  const anonymous = await app.fetch(new Request('http://localhost/v1/proposals', {
    method: 'POST', body: JSON.stringify({ start: slotAt(24).start, key: '30min', timeZone: 'UTC' }),
    headers: { 'Content-Type': 'application/json', Origin: config.SITE_ORIGIN },
  }));
  assert.equal(anonymous.status, 401);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 0);
});
