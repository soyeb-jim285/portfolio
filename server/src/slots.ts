// Free-slot arithmetic. Kept pure and provider-free so the awkward parts, local working hours
// across a daylight-saving change, are testable without touching a calendar.
export type Interval = { start: number; end: number };
export type WorkingHours = { days: number[]; start: string; end: string };
export type SlotOptions = {
  from: Date; to: Date; timeZone: string; hours: WorkingHours;
  durationMinutes: number; bufferMinutes: number; noticeMinutes: number; stepMinutes: number;
};

const MINUTE = 60_000;
const parts = (instant: number, timeZone: string) => {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(new Date(instant));
  const value = (type: string) => formatted.find(part => part.type === type)!.value;
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    // Intl renders midnight as 24 in some locales' hour12:false output.
    minutes: (Number(value('hour')) % 24) * 60 + Number(value('minute')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value('weekday')),
  };
};

// The instant whose wall clock in `timeZone` is the given date and minute-of-day.
// Two correction passes settle any offset, including a change between guess and result.
// Returns null for a local time that does not exist, the hour skipped on a spring-forward day.
export function instantOfLocal(date: string, minuteOfDay: number, timeZone: string): number | null {
  const [year, month, day] = date.split('-').map(Number);
  let guess = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  for (let pass = 0; pass < 2; pass++) {
    const shown = parts(guess, timeZone);
    const wanted = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
    const actual = Date.UTC(...shown.date.split('-').map((value, index) => index === 1 ? Number(value) - 1 : Number(value)) as [number, number, number],
      Math.floor(shown.minutes / 60), shown.minutes % 60);
    if (actual === wanted) return guess;
    guess += wanted - actual;
  }
  const final = parts(guess, timeZone);
  return final.date === date && final.minutes === minuteOfDay ? guess : null;
}

const minuteOfDay = (time: string) => {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + (minute || 0);
};

// Busy intervals grow by the buffer on both sides, so a call never touches another.
const overlapsBusy = (start: number, end: number, busy: Interval[], buffer: number) =>
  busy.some(interval => start < interval.end + buffer * MINUTE && end > interval.start - buffer * MINUTE);

export function freeSlots(busy: Interval[], options: SlotOptions) {
  const { from, to, timeZone, hours, durationMinutes, bufferMinutes, noticeMinutes, stepMinutes } = options;
  const earliest = Date.now() + noticeMinutes * MINUTE;
  const windowStart = Math.max(from.getTime(), earliest);
  const windowEnd = to.getTime();
  const openMinute = minuteOfDay(hours.start);
  const closeMinute = minuteOfDay(hours.end);
  const slots: { start: string; end: string }[] = [];
  if (closeMinute <= openMinute || windowEnd <= windowStart) return slots;

  // Walk local days from one before the window to one after, so a day is never missed at an edge.
  // A 23-hour day can put two cursors on the same local date, so each date is generated once.
  const seen = new Set<string>();
  for (let cursor = windowStart - 86_400_000; cursor <= windowEnd + 86_400_000; cursor += 86_400_000) {
    const day = parts(cursor, timeZone);
    if (!hours.days.includes(day.weekday)) continue;
    if (seen.has(day.date)) continue;
    seen.add(day.date);
    for (let minute = openMinute; minute + durationMinutes <= closeMinute; minute += stepMinutes) {
      const start = instantOfLocal(day.date, minute, timeZone);
      if (start === null) continue;
      const end = start + durationMinutes * MINUTE;
      if (start < windowStart || end > windowEnd) continue;
      if (overlapsBusy(start, end, busy, bufferMinutes)) continue;
      slots.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
    }
  }
  return slots.sort((a, b) => a.start.localeCompare(b.start));
}
