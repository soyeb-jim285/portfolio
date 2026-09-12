import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoogleScheduler } from './google-calendar';
import { AmbiguousBookingError } from './scheduler';

const config = {
  GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'refresh',
  GOOGLE_CALENDAR_ID: 'primary', GOOGLE_ADD_MEET: false,
  MEETING_TYPES: [{ key: '30min', minutes: 30, label: 'Intro call' }],
  MEETING_TIME_ZONE: 'Asia/Dhaka', MEETING_HOURS: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  BOOKING_NOTICE_MINUTES: 0, BOOKING_BUFFER_MINUTES: 10, BOOKING_STEP_MINUTES: 30,
};
const eventType = config.MEETING_TYPES[0];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const window = () => ({ from: new Date(), to: new Date(Date.now() + 7 * 86_400_000) });

// Records every call so the tests can assert on what Google was actually asked.
const recorder = (handlers: { token?: () => Response; freeBusy?: (body: any) => Response; insert?: (body: any, url: URL) => Response }) => {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = (async (input: any, init: any) => {
    const url = new URL(String(input));
    const raw = init?.body;
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw ? Object.fromEntries(raw as URLSearchParams) : undefined;
    calls.push({ url: url.toString(), body });
    if (url.hostname === 'oauth2.googleapis.com') return handlers.token?.() ?? json({ access_token: 'token-1', expires_in: 3600 });
    if (url.pathname.endsWith('/freeBusy')) return handlers.freeBusy?.(body) ?? json({ calendars: { primary: { busy: [] } } });
    return handlers.insert?.(body, url) ?? json({ id: 'event-1' });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

test('the refresh token is exchanged once and the access token reused', async () => {
  let tokenCalls = 0;
  const { calls, fetchImpl } = recorder({ token: () => { tokenCalls++; return json({ access_token: 'token-1', expires_in: 3600 }); } });
  const scheduler = createGoogleScheduler(config, fetchImpl);
  assert.equal(scheduler.configured, true);
  await scheduler.availability(eventType, window().from, window().to, 'Europe/Rome');
  await scheduler.availability(eventType, window().from, window().to, 'Europe/Rome');
  assert.equal(tokenCalls, 1, 'a cached access token must be reused');
  assert.deepEqual(calls[0].body, { client_id: 'client', client_secret: 'secret', refresh_token: 'refresh', grant_type: 'refresh_token' });
  assert.equal(calls[1].body.items[0].id, 'primary');
});

test('busy time from the calendar removes slots, and the visitor zone does not move them', async () => {
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const busyStart = `${day}T05:00:00.000Z`; // 11:00 Dhaka
  const { fetchImpl } = recorder({ freeBusy: () => json({ calendars: { primary: { busy: [{ start: busyStart, end: `${day}T06:00:00.000Z` }] } } }) });
  const scheduler = createGoogleScheduler(config, fetchImpl);
  const { from, to } = window();
  const rome = await scheduler.availability(eventType, from, to, 'Europe/Rome');
  const dhaka = await scheduler.availability(eventType, from, to, 'Asia/Dhaka');
  assert.deepEqual(rome, dhaka, 'slots are the host calendar, not the visitor clock');
  const onThatDay = rome.filter(slot => slot.start.startsWith(day));
  if (onThatDay.length) {
    assert.ok(!onThatDay.some(slot => slot.start >= `${day}T04:50:00` && slot.start < `${day}T06:10:00`), 'a busy hour plus buffer was offered');
  }
  assert.ok(rome.every(slot => new Date(slot.end).getTime() - new Date(slot.start).getTime() === 1_800_000));
});

test('a calendar that cannot be read is an error, never an empty diary', async () => {
  const denied = createGoogleScheduler(config, recorder({ freeBusy: () => json({ calendars: { primary: { errors: [{ reason: 'notFound' }] } } }) }).fetchImpl);
  await assert.rejects(denied.availability(eventType, window().from, window().to, 'UTC'), /could not be read/);
  const missing = createGoogleScheduler(config, recorder({ freeBusy: () => json({ calendars: {} }) }).fetchImpl);
  await assert.rejects(missing.availability(eventType, window().from, window().to, 'UTC'), /could not be read/);
  const broken = createGoogleScheduler(config, recorder({ freeBusy: () => json({ error: 'nope' }, 403) }).fetchImpl);
  await assert.rejects(broken.availability(eventType, window().from, window().to, 'UTC'), /Availability lookup failed \(403\)/);
  const refused = createGoogleScheduler(config, recorder({ token: () => json({ error: 'invalid_grant' }, 400) }).fetchImpl);
  await assert.rejects(refused.availability(eventType, window().from, window().to, 'UTC'), /refused the refresh token/);
});

test('booking creates an invited event in the host time zone', async () => {
  const { calls, fetchImpl } = recorder({});
  const scheduler = createGoogleScheduler(config, fetchImpl);
  const start = '2026-09-14T04:00:00.000Z';
  const result = await scheduler.book({ eventTypeKey: '30min', start, name: 'Ada', email: 'ada@example.com', timeZone: 'Europe/Rome', notes: 'Qt work' });
  assert.equal(result.uid, 'event-1');
  const insert = calls.at(-1)!;
  assert.match(insert.url, /\/calendars\/primary\/events\?sendUpdates=all$/);
  assert.equal(insert.body.start.dateTime, start);
  assert.equal(insert.body.end.dateTime, '2026-09-14T04:30:00.000Z');
  assert.equal(insert.body.start.timeZone, 'Asia/Dhaka');
  assert.deepEqual(insert.body.attendees, [{ email: 'ada@example.com', displayName: 'Ada', responseStatus: 'needsAction' }]);
  assert.match(insert.body.summary, /Intro call with Ada/);
  assert.match(insert.body.description, /Qt work/);
  assert.equal(insert.body.extendedProperties.private.guestTimeZone, 'Europe/Rome');
  assert.equal(insert.body.conferenceData, undefined, 'no Meet link unless asked for');
});

test('a Meet link is requested only when configured', async () => {
  const { calls, fetchImpl } = recorder({});
  const scheduler = createGoogleScheduler({ ...config, GOOGLE_ADD_MEET: true }, fetchImpl);
  await scheduler.book({ eventTypeKey: '30min', start: '2026-09-14T04:00:00.000Z', name: 'Ada', email: 'ada@example.com', timeZone: 'UTC' });
  const insert = calls.at(-1)!;
  assert.match(insert.url, /conferenceDataVersion=1/);
  assert.equal(insert.body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
});

test('an unanswered or failing insert is reported so it is never retried blindly', async () => {
  const timedOut = createGoogleScheduler(config, recorder({ insert: () => { throw new Error('socket hang up'); } }).fetchImpl);
  await assert.rejects(timedOut.book({ eventTypeKey: '30min', start: '2026-09-14T04:00:00.000Z', name: 'A', email: 'a@b.co', timeZone: 'UTC' }), AmbiguousBookingError);
  const serverError = createGoogleScheduler(config, recorder({ insert: () => json({ error: 'boom' }, 503) }).fetchImpl);
  await assert.rejects(serverError.book({ eventTypeKey: '30min', start: '2026-09-14T04:00:00.000Z', name: 'A', email: 'a@b.co', timeZone: 'UTC' }), AmbiguousBookingError);
  const rejected = createGoogleScheduler(config, recorder({ insert: () => json({ error: 'bad' }, 400) }).fetchImpl);
  await assert.rejects(rejected.book({ eventTypeKey: '30min', start: '2026-09-14T04:00:00.000Z', name: 'A', email: 'a@b.co', timeZone: 'UTC' }), /Booking rejected \(400\)/);
  await assert.rejects(createGoogleScheduler(config, recorder({}).fetchImpl).book({ eventTypeKey: '90min', start: '2026-09-14T04:00:00.000Z', name: 'A', email: 'a@b.co', timeZone: 'UTC' }), /Unknown meeting length/);
});

test('without credentials nothing is configured and nothing is called', async () => {
  const { calls, fetchImpl } = recorder({});
  const scheduler = createGoogleScheduler({ ...config, GOOGLE_REFRESH_TOKEN: undefined }, fetchImpl);
  assert.equal(scheduler.configured, false);
  await assert.rejects(scheduler.availability(eventType, window().from, window().to, 'UTC'), /not configured/);
  await assert.rejects(scheduler.book({ eventTypeKey: '30min', start: '2026-09-14T04:00:00.000Z', name: 'A', email: 'a@b.co', timeZone: 'UTC' }), /not configured/);
  assert.deepEqual(calls, []);
});
