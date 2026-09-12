import assert from 'node:assert/strict';
import test from 'node:test';
import { createCalScheduler } from './cal-calendar';
import { AmbiguousBookingError } from './scheduler';

const config = {
  CAL_API_KEY: 'cal_test', CAL_API_BASE: 'https://api.cal.com/v2',
  CAL_SLOTS_API_VERSION: '2024-09-04', CAL_BOOKINGS_API_VERSION: '2024-08-13',
  CAL_EVENT_TYPES: [
    { id: 7034884, key: '30min', minutes: 30, label: 'Intro call' },
    { id: 7034885, key: '15min', minutes: 15, label: 'Quick chat' },
  ],
};
const intro = { key: '30min', minutes: 30, label: 'Intro call' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const recorder = (handler?: (url: URL, body: any) => Response) => {
  const calls: { url: URL; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body });
    return handler?.(url, body) ?? json({ data: { '2026-09-14': [{ start: '2026-09-14T09:00:00.000+06:00', end: '2026-09-14T09:30:00.000+06:00' }] } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

test('availability is requested per event type in the visitor time zone', async () => {
  const { calls, fetchImpl } = recorder();
  const scheduler = createCalScheduler(config, fetchImpl);
  assert.equal(scheduler.configured, true);
  assert.deepEqual(scheduler.eventTypes.map(type => type.key), ['30min', '15min']);
  // The event type id is an implementation detail and must not leak into the interface.
  assert.equal((scheduler.eventTypes[0] as Record<string, unknown>).id, undefined);

  const slots = await scheduler.availability(intro, new Date('2026-09-14T00:00:00Z'), new Date('2026-09-15T00:00:00Z'), 'Asia/Dhaka');
  assert.deepEqual(slots, [{ start: '2026-09-14T03:00:00.000Z', end: '2026-09-14T03:30:00.000Z' }]);
  const request = calls[0];
  assert.equal(request.url.searchParams.get('eventTypeId'), '7034884');
  assert.equal(request.url.searchParams.get('timeZone'), 'Asia/Dhaka');
  assert.equal(request.url.searchParams.get('format'), 'range');
  assert.equal(request.headers['cal-api-version'], '2024-09-04');
  assert.equal(request.headers.Authorization, 'Bearer cal_test');
});

test('booking posts the attendee and returns the provider reference', async () => {
  const { calls, fetchImpl } = recorder((url) => url.pathname.endsWith('/bookings') ? json({ data: { uid: 'booking_9' } }) : json({ data: {} }));
  const scheduler = createCalScheduler(config, fetchImpl);
  const result = await scheduler.book({ eventTypeKey: '15min', start: '2026-09-14T04:00:00.000Z', name: 'Ada', email: 'ada@example.com', timeZone: 'Europe/Rome', notes: 'Qt work' });
  assert.equal(result.uid, 'booking_9');
  const booking = calls.at(-1)!;
  assert.equal(booking.headers['cal-api-version'], '2024-08-13');
  assert.equal(booking.body.eventTypeId, 7034885, 'the meeting key selects the event type');
  assert.deepEqual(booking.body.attendee, { name: 'Ada', email: 'ada@example.com', timeZone: 'Europe/Rome', language: 'en' });
  assert.equal(booking.body.bookingFieldsResponses.notes, 'Qt work');
});

test('failures are classified so an unanswered booking is never retried', async () => {
  const timedOut = createCalScheduler(config, recorder(() => { throw new Error('socket hang up'); }).fetchImpl);
  await assert.rejects(timedOut.book({ eventTypeKey: '30min', start: '2026-09-14T04:00:00.000Z', name: 'A', email: 'a@b.co', timeZone: 'UTC' }), AmbiguousBookingError);
  const serverError = createCalScheduler(config, recorder(() => json({ error: 'boom' }, 502)).fetchImpl);
  await assert.rejects(serverError.book({ eventTypeKey: '30min', start: '2026-09-14T04:00:00.000Z', name: 'A', email: 'a@b.co', timeZone: 'UTC' }), AmbiguousBookingError);
  const rejected = createCalScheduler(config, recorder(() => json({ error: 'taken' }, 400)).fetchImpl);
  await assert.rejects(rejected.book({ eventTypeKey: '30min', start: '2026-09-14T04:00:00.000Z', name: 'A', email: 'a@b.co', timeZone: 'UTC' }), /Booking rejected \(400\)/);
  const lookupFailed = createCalScheduler(config, recorder(() => json({ error: 'nope' }, 403)).fetchImpl);
  await assert.rejects(lookupFailed.availability(intro, new Date(), new Date(Date.now() + 86400000), 'UTC'), /Availability lookup failed \(403\)/);
  await assert.rejects(createCalScheduler(config, recorder().fetchImpl).book({ eventTypeKey: '90min', start: '2026-09-14T04:00:00.000Z', name: 'A', email: 'a@b.co', timeZone: 'UTC' }), /Unknown meeting length/);
});

test('without a key or event types nothing is configured and nothing is called', async () => {
  for (const broken of [{ ...config, CAL_API_KEY: undefined }, { ...config, CAL_EVENT_TYPES: [] }]) {
    const { calls, fetchImpl } = recorder();
    const scheduler = createCalScheduler(broken, fetchImpl);
    assert.equal(scheduler.configured, false);
    await assert.rejects(scheduler.availability(intro, new Date(), new Date(Date.now() + 86400000), 'UTC'), /not configured/);
    await assert.rejects(scheduler.book({ eventTypeKey: '30min', start: '2026-09-14T04:00:00.000Z', name: 'A', email: 'a@b.co', timeZone: 'UTC' }), /not configured/);
    assert.deepEqual(calls, []);
  }
});
