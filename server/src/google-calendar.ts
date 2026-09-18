// Google Calendar as the scheduling provider. Availability is computed here from the real
// free/busy list, because Google has no notion of bookable slots: only busy time.
import { freeSlots, type Interval, type WorkingHours } from './slots';
import { AmbiguousBookingError, type EventType, type Scheduler, type Slot } from './scheduler';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

export type GoogleConfig = {
  GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; GOOGLE_REFRESH_TOKEN?: string;
  GOOGLE_CALENDAR_ID: string; GOOGLE_ADD_MEET: boolean;
  MEETING_TYPES: EventType[]; MEETING_TIME_ZONE: string; MEETING_HOURS: WorkingHours;
  BOOKING_NOTICE_MINUTES: number; BOOKING_BUFFER_MINUTES: number; BOOKING_STEP_MINUTES: number;
};

export function createGoogleScheduler(config: GoogleConfig, fetchImpl: typeof fetch = fetch): Scheduler {
  const configured = Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REFRESH_TOKEN && config.MEETING_TYPES.length);
  // Access tokens last an hour; keep one until it is nearly spent rather than minting per request.
  let token: { value: string; expiresAt: number } | undefined;
  let refreshing: Promise<string> | undefined;

  async function refreshToken() {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.GOOGLE_CLIENT_ID!, client_secret: config.GOOGLE_CLIENT_SECRET!,
        refresh_token: config.GOOGLE_REFRESH_TOKEN!, grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Google refused the refresh token (${response.status})`);
    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('Google returned no access token');
    token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return token.value;
  }
  const accessToken = () => refreshing ??= refreshToken().finally(() => { refreshing = undefined; });

  return {
    configured,
    eventTypes: config.MEETING_TYPES,

    async availability(eventType, from, to, _visitorTimeZone) {
      if (!configured) throw new Error('Scheduling is not configured');
      const response = await fetchImpl(`${API}/freeBusy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: config.GOOGLE_CALENDAR_ID }] }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Availability lookup failed (${response.status})`);
      const body = await response.json() as { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> };
      const calendar = body.calendars?.[config.GOOGLE_CALENDAR_ID];
      // An unreadable calendar must not look like a free one.
      if (!calendar || calendar.errors?.length) throw new Error('The calendar could not be read');
      const busy: Interval[] = (calendar.busy ?? []).map(interval => ({ start: Date.parse(interval.start), end: Date.parse(interval.end) }));
      // Slots are generated in Jim's working hours; the visitor's zone only changes how they are displayed.
      return freeSlots(busy, {
        from, to, timeZone: config.MEETING_TIME_ZONE, hours: config.MEETING_HOURS,
        durationMinutes: eventType.minutes, bufferMinutes: config.BOOKING_BUFFER_MINUTES,
        noticeMinutes: config.BOOKING_NOTICE_MINUTES, stepMinutes: config.BOOKING_STEP_MINUTES,
      }) as Slot[];
    },

    async book({ eventTypeKey, start, name, email, timeZone, notes }) {
      if (!configured) throw new Error('Scheduling is not configured');
      const eventType = config.MEETING_TYPES.find(type => type.key === eventTypeKey);
      if (!eventType) throw new Error('Unknown meeting length');
      const end = new Date(new Date(start).getTime() + eventType.minutes * 60_000).toISOString();
      const url = new URL(`${API}/calendars/${encodeURIComponent(config.GOOGLE_CALENDAR_ID)}/events`);
      url.searchParams.set('sendUpdates', 'all');
      if (config.GOOGLE_ADD_MEET) url.searchParams.set('conferenceDataVersion', '1');

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summary: `${eventType.label} with ${name}`,
            description: [`Booked through the assistant on soyebjim.me.`, `Guest: ${name} <${email}>`, notes].filter(Boolean).join('\n'),
            start: { dateTime: start, timeZone: config.MEETING_TIME_ZONE },
            end: { dateTime: end, timeZone: config.MEETING_TIME_ZONE },
            attendees: [{ email, displayName: name, responseStatus: 'needsAction' }],
            guestsCanModify: false, guestsCanInviteOthers: false,
            // The guest's own zone, so their invite shows the time they picked.
            ...(timeZone ? { extendedProperties: { private: { guestTimeZone: timeZone } } } : {}),
            ...(config.GOOGLE_ADD_MEET ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
          }),
          signal: AbortSignal.timeout(20000),
        });
      } catch (error) {
        // The event may exist already, so this must never be retried blindly.
        throw new AmbiguousBookingError(error instanceof Error ? error.message : 'Booking request did not complete');
      }
      if (response.status >= 500) throw new AmbiguousBookingError(`Provider error (${response.status})`);
      if (!response.ok) throw new Error(`Booking rejected (${response.status})`);
      const body = await response.json().catch(() => ({})) as { id?: string; htmlLink?: string };
      return { uid: body.id ?? '' };
    },
  };
}
