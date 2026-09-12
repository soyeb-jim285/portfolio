// Provider-neutral scheduling interface. Implemented by `cal-calendar.ts` (the default) and
// `google-calendar.ts`; SCHEDULER picks one. This file holds the shapes and the one error the
// API treats specially.
export type Slot = { start: string; end: string };
// A meeting length the visitor can book. `key` is what the model and the browser pass around.
export type EventType = { key: string; minutes: number; label: string };
export type Scheduler = {
  configured: boolean;
  eventTypes: EventType[];
  availability(eventType: EventType, from: Date, to: Date, visitorTimeZone: string): Promise<Slot[]>;
  book(input: { eventTypeKey: string; start: string; name: string; email: string; timeZone: string; notes?: string }): Promise<{ uid: string }>;
};

// Thrown when the provider may or may not have created the booking. Never retried automatically.
export class AmbiguousBookingError extends Error {}
