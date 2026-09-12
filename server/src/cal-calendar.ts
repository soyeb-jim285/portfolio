// Cal.com API v2 as the scheduling provider: it owns the working hours, buffers and slot
// generation, so this file only translates between its shapes and the Scheduler interface.
import { AmbiguousBookingError, type EventType, type Scheduler, type Slot } from './scheduler';

export type CalEventType = EventType & { id: number };
export type CalConfig = {
  CAL_API_KEY?: string; CAL_EVENT_TYPES: CalEventType[]; CAL_API_BASE: string;
  CAL_SLOTS_API_VERSION: string; CAL_BOOKINGS_API_VERSION: string;
};

export function createCalScheduler(config: CalConfig, fetchImpl: typeof fetch = fetch): Scheduler {
  const configured = Boolean(config.CAL_API_KEY && config.CAL_EVENT_TYPES.length);
  const headers = (version: string) => ({
    Authorization: `Bearer ${config.CAL_API_KEY}`, 'Content-Type': 'application/json', 'cal-api-version': version,
  });
  const base = config.CAL_API_BASE.replace(/\/$/, '');
  // The event type id never leaves this module; everything else speaks in meeting keys.
  const idOf = (key: string) => config.CAL_EVENT_TYPES.find(type => type.key === key)?.id;

  return {
    configured,
    eventTypes: config.CAL_EVENT_TYPES.map(({ key, minutes, label }) => ({ key, minutes, label })),

    async availability(eventType, from, to, visitorTimeZone) {
      if (!configured) throw new Error('Scheduling is not configured');
      const id = idOf(eventType.key);
      if (!id) throw new Error('Unknown meeting length');
      const url = new URL(`${base}/slots`);
      url.searchParams.set('eventTypeId', String(id));
      url.searchParams.set('start', from.toISOString());
      url.searchParams.set('end', to.toISOString());
      url.searchParams.set('timeZone', visitorTimeZone);
      url.searchParams.set('format', 'range');
      const response = await fetchImpl(url, { headers: headers(config.CAL_SLOTS_API_VERSION), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Availability lookup failed (${response.status})`);
      const body = await response.json() as { data?: Record<string, { start: string; end: string }[]> };
      return Object.values(body.data ?? {}).flat()
        .filter(slot => slot?.start && slot?.end)
        .map(slot => ({ start: new Date(slot.start).toISOString(), end: new Date(slot.end).toISOString() }))
        .sort((a, b) => a.start.localeCompare(b.start)) as Slot[];
    },

    async book({ eventTypeKey, start, name, email, timeZone, notes }) {
      if (!configured) throw new Error('Scheduling is not configured');
      const eventTypeId = idOf(eventTypeKey);
      if (!eventTypeId) throw new Error('Unknown meeting length');
      let response: Response;
      try {
        response = await fetchImpl(`${base}/bookings`, {
          method: 'POST', headers: headers(config.CAL_BOOKINGS_API_VERSION),
          body: JSON.stringify({
            eventTypeId, start,
            attendee: { name, email, timeZone, language: 'en' },
            ...(notes ? { bookingFieldsResponses: { notes } } : {}),
          }),
          signal: AbortSignal.timeout(20000),
        });
      } catch (error) {
        // The booking may exist upstream, so this must never be retried blindly.
        throw new AmbiguousBookingError(error instanceof Error ? error.message : 'Booking request did not complete');
      }
      if (response.status >= 500) throw new AmbiguousBookingError(`Provider error (${response.status})`);
      if (!response.ok) throw new Error(`Booking rejected (${response.status})`);
      const body = await response.json().catch(() => ({})) as { data?: { uid?: string } };
      return { uid: body.data?.uid ?? '' };
    },
  };
}
