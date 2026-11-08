import { availabilityArgs, proposalArgs } from './args';
import { asEvidence, fail } from './outcome';
import type { EventTypeChoice, Slot, ToolContext, ToolOutcome } from './types';

const MAX_PICKER_SLOTS = 120;

// A missing or unknown length falls back to the first configured meeting rather than guessing an id.
const pickEventType = (types: EventTypeChoice[], duration?: string) =>
  duration ? types.find(type => type.key === duration.trim().toLowerCase() || String(type.minutes) === duration.trim()) : types[0];

export async function getAvailability(context: ToolContext, parsed: unknown): Promise<ToolOutcome> {
  if (!context.scheduling) return fail('scheduling unavailable', 'Scheduling is not configured, so there is no availability to show. Suggest a message instead.');
  const args = availabilityArgs.safeParse(parsed);
  if (!args.success) return fail('invalid arguments', 'Invalid availability arguments.');
  const eventType = pickEventType(context.scheduling.eventTypes, args.data.duration);
  if (!eventType) return fail('unknown meeting length', `Unknown meeting length. Choose one of: ${context.scheduling.eventTypes.map(type => type.key).join(', ')}.`);
  let slots: Slot[];
  try { slots = await context.scheduling.availability(eventType); }
  catch { return fail('availability lookup failed', 'The calendar could not be reached. Say so; never guess at free times.'); }
  const timeZone = context.scheduling.timeZone;
  if (!slots.length) return { summary: `availability ${eventType.key}: none`, result: asEvidence(`There is no free time for the ${eventType.label} in the booking window. Offer another length or a message instead.`), sources: [], slots: { timeZone, eventType, slots } };
  // The picker gets the slots; the model gets a short sample plus the day summary, so a
  // week of availability does not cost a thousand prompt tokens.
  const shown = slots.slice(0, MAX_PICKER_SLOTS);
  const byDay = new Map<string, number>();
  for (const slot of shown) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(slot.start));
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const sample = shown.slice(0, 8).map(slot => slot.start).join('\n');
  return {
    summary: `availability ${eventType.key}: ${slots.length} slot${slots.length === 1 ? '' : 's'}`,
    result: asEvidence(`Free slots for the ${eventType.label} (${eventType.minutes} minutes) in ${timeZone}, already shown to the visitor as a day-by-day picker.\n`
      + `${[...byDay].map(([day, count]) => `${day}: ${count} slots`).join('\n')}\n`
      + `Earliest are:\n${sample}\n`
      + `Describe the days and the rough hours, point at the picker, and do not list every time. Only times in the picker exist: never invent one, and let the visitor choose and confirm.`),
    sources: [], slots: { timeZone, eventType, slots: shown },
  };
}

export async function proposeBooking(context: ToolContext, parsed: unknown): Promise<ToolOutcome> {
  if (!context.scheduling) return fail('scheduling unavailable', 'Scheduling is not configured, so no call can be proposed.');
  const args = proposalArgs.safeParse(parsed);
  if (!args.success) return fail('invalid arguments', `Invalid proposal: ${args.error.issues[0]?.message}`);
  const start = new Date(args.data.start);
  if (Number.isNaN(start.getTime())) return fail('invalid arguments', 'The start time is not a valid ISO 8601 instant.');
  const eventType = pickEventType(context.scheduling.eventTypes, args.data.duration);
  if (!eventType) return fail('unknown meeting length', `Unknown meeting length. Choose one of: ${context.scheduling.eventTypes.map(type => type.key).join(', ')}.`);
  let slots: Slot[];
  try { slots = await context.scheduling.availability(eventType); }
  catch { return fail('availability lookup failed', 'The calendar could not be reached, so this time cannot be offered.'); }
  if (!slots.some(slot => slot.start === start.toISOString())) {
    return { summary: 'slot not available', result: asEvidence('That time is not free for this meeting length. Call get_availability and offer only the times it returns.'), sources: [], slots: { timeZone: context.scheduling.timeZone, eventType, slots: slots.slice(0, MAX_PICKER_SLOTS) } };
  }
  return {
    summary: `propose ${eventType.key} ${start.toISOString()}`,
    result: asEvidence('A confirmation card is now shown with that slot and the attendee details. You cannot book: the visitor checks the time and their details and confirms. Never say a call is booked.'),
    sources: [],
    proposal: { eventType, start: start.toISOString(), name: args.data.name ?? '', email: args.data.email ?? '', notes: args.data.notes ?? '' },
  };
}
