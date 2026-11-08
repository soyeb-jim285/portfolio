import { createRoute, z } from '@hono/zod-openapi';
import { AmbiguousBookingError } from '../scheduler';
import type { App, AppDeps } from './deps';
import { authFailure, authHeader, errorSchema, guardFailures, proposalSchema, slotSchema } from './schemas';

export function registerBookingRoutes(app: App, { config, db, scheduler, timeZoneOf, availableSlots }: AppDeps) {
  app.openapi(createRoute({
    method: 'post', path: '/v1/proposals', summary: 'Hold a slot for confirmation',
    description: 'Called when the visitor picks a time in the slot picker, so a call can be confirmed without the model proposing one first. The slot is checked against live availability and nothing is booked: it only creates the pending proposal that /v1/bookings confirms.',
    request: {
      headers: authHeader,
      body: { required: true, content: { 'application/json': { schema: z.object({
        start: z.string().datetime(),
        key: z.string().trim().min(1).max(16),
        timeZone: z.string().trim().min(1).max(64),
      }).strict() } } },
    },
    responses: {
      201: { description: 'Proposal created', content: { 'application/json': { schema: proposalSchema } } },
      409: { description: 'The slot is no longer free', content: { 'application/json': { schema: z.object({ error: z.string(), slots: z.array(slotSchema) }) } } },
      404: { description: 'No such meeting length', content: { 'application/json': { schema: errorSchema } } },
      400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
      502: { description: 'The calendar could not be reached', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Scheduling is not configured', content: { 'application/json': { schema: errorSchema } } },
      ...authFailure, ...guardFailures,
    },
  }), async c => {
    if (!scheduler.configured) return c.json({ error: 'Scheduling is not configured on this server.' }, 503);
    const body = c.req.valid('json');
    const eventType = scheduler.eventTypes.find(type => type.key === body.key);
    if (!eventType) return c.json({ error: 'That meeting length is not offered.' }, 404);
    const timeZone = timeZoneOf(body.timeZone);
    const start = new Date(body.start).toISOString();

    let slots;
    try { slots = await availableSlots(eventType, timeZone); }
    catch { return c.json({ error: 'The calendar could not be reached. Please try again shortly.' }, 502); }
    if (!slots.some(slot => slot.start === start)) {
      return c.json({ error: 'That time was just taken. Pick another one.', slots: slots.slice(0, 120) }, 409);
    }

    const id = await db.createBooking({ sessionId: c.get('sessionId'), meetingKey: eventType.key, slotStart: start, name: '', email: '', timeZone, notes: '' }, config.BOOKING_TTL_MINUTES);
    return c.json({
      id, start, end: new Date(new Date(start).getTime() + eventType.minutes * 60000).toISOString(),
      timeZone, durationMinutes: eventType.minutes, label: eventType.label, key: eventType.key, name: '', email: '', notes: '',
    }, 201);
  });

  app.use('/v1/bookings', async (c, next) => {
    const release = await db.acquireBookingLock();
    if (!release) {
      c.header('Retry-After', '5');
      return c.json({ error: 'Another booking is being confirmed. Please try again shortly.' }, 429);
    }
    try { await next(); } finally { await release(); }
  });
  app.openapi(createRoute({
    method: 'post', path: '/v1/bookings', summary: 'Confirm a call',
    description: 'The only path to the calendar provider, and the model never reaches it: the visitor confirms the slot and their own details. The slot is re-checked against live availability first, so a time taken in the meantime returns 409 with the current slots. Confirming the same proposal twice returns the first booking. If the provider does not answer, the proposal is left unresolved rather than retried, because the booking may already exist.',
    request: {
      headers: authHeader,
      body: { required: true, content: { 'application/json': { schema: z.object({
        proposalId: z.string().uuid(),
        start: z.string().datetime(),
        name: z.string().trim().min(1).max(120),
        email: z.string().trim().email().max(200),
        timeZone: z.string().trim().min(1).max(64),
      }).strict() } } },
    },
    responses: {
      201: { description: 'Booked with the provider', content: { 'application/json': { schema: z.object({ id: z.string(), uid: z.string(), start: z.string(), status: z.enum(['confirmed', 'already-booked']) }) } } },
      409: { description: 'The slot is no longer free', content: { 'application/json': { schema: z.object({ error: z.string(), slots: z.array(slotSchema) }) } } },
      502: { description: 'The provider rejected the booking', content: { 'application/json': { schema: errorSchema } } },
      504: { description: 'The provider did not answer; the booking may exist', content: { 'application/json': { schema: errorSchema } } },
      404: { description: 'No such proposal for this session', content: { 'application/json': { schema: errorSchema } } },
      400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Scheduling is not configured', content: { 'application/json': { schema: errorSchema } } },
      ...authFailure, ...guardFailures,
    },
  }), async c => {
    if (!scheduler.configured) return c.json({ error: 'Scheduling is not configured on this server.' }, 503);
    const body = c.req.valid('json');
    const sessionId = c.get('sessionId');
    const start = new Date(body.start).toISOString();
    const timeZone = timeZoneOf(body.timeZone);

    const claim = await db.claimBooking(body.proposalId, sessionId, { slotStart: start, name: body.name, email: body.email, timeZone });
    // The meeting length is whatever was proposed and stored: the caller cannot switch it.
    const eventType = scheduler.eventTypes.find(type => type.key === claim.meetingKey);
    if (!claim.claimed) {
      if (claim.status === 'confirmed') return c.json({ id: body.proposalId, uid: claim.providerUid ?? '', start: claim.slotStart?.toISOString() ?? start, status: 'already-booked' as const }, 201);
      if (claim.status === 'unknown') return c.json({ error: 'That confirmation never came back from the calendar. Check your email before trying again.' }, 504);
      return c.json({ error: 'That proposal is no longer available. Ask for times again.' }, 404);
    }

    if (!eventType) {
      await db.finishBooking(body.proposalId, 'failed');
      return c.json({ error: 'That meeting is no longer offered. Ask for times again.' }, 404);
    }
    // Re-check live availability: a slot free when it was proposed may be taken by now.
    let slots;
    try { slots = await availableSlots(eventType, timeZone); }
    catch {
      await db.finishBooking(body.proposalId, 'failed');
      return c.json({ error: 'The calendar could not be reached. Please try again shortly.' }, 502);
    }
    if (!slots.some(slot => slot.start === start)) {
      await db.finishBooking(body.proposalId, 'conflict');
      return c.json({ error: 'That time was taken while you were deciding. Pick another one.', slots: slots.slice(0, 40) }, 409);
    }

    if (!await db.reserveBooking(config.BOOKINGS_PER_DAY)) {
      await db.finishBooking(body.proposalId, 'failed');
      return c.json({ error: 'The daily booking limit is reached. Please send a message instead.' }, 429);
    }
    let uid: string;
    try {
      ({ uid } = await scheduler.book({ eventTypeKey: eventType.key, start, name: body.name, email: body.email, timeZone, notes: '' }));
    } catch (error) {
      if (error instanceof AmbiguousBookingError) {
        // The booking may exist upstream: leave it unresolved so nothing books it twice.
        console.error('Booking outcome unknown:', error.message);
        await db.finishBooking(body.proposalId, 'unknown');
        return c.json({ error: 'The calendar did not confirm in time. Check your email before booking again, so you are not booked twice.' }, 504);
      }
      console.error('Booking rejected:', error instanceof Error ? error.message : error);
      await db.finishBooking(body.proposalId, 'failed');
      await db.releaseBooking().catch(() => {});
      return c.json({ error: 'The calendar rejected that booking. Pick another time or send a message.' }, 502);
    }
    await db.finishBooking(body.proposalId, 'confirmed', uid);
    return c.json({ id: body.proposalId, uid, start, status: 'confirmed' as const }, 201);
  });
}
