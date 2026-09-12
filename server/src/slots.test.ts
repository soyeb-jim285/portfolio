import assert from 'node:assert/strict';
import test from 'node:test';
import { freeSlots, instantOfLocal } from './slots';

const weekdays = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };
const base = { timeZone: 'Asia/Dhaka', hours: weekdays, durationMinutes: 30, bufferMinutes: 10, noticeMinutes: 0, stepMinutes: 30 };
// Structured rather than sliced: Intl's separators differ by locale and would make the test lie.
const local = (iso: string, timeZone = 'Asia/Dhaka') => {
  const found = new Intl.DateTimeFormat('en-GB', { timeZone, hour12: false, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(iso));
  const value = (type: string) => found.find(part => part.type === type)!.value;
  return { weekday: value('weekday'), day: `${value('day')}/${value('month')}`, time: `${value('hour')}:${value('minute')}`, hour: Number(value('hour')) };
};

test('local wall clock maps to the right instant, including across a daylight-saving change', () => {
  // Dhaka never shifts: 09:00 local is always 03:00 UTC.
  assert.equal(new Date(instantOfLocal('2026-09-14', 9 * 60, 'Asia/Dhaka')!).toISOString(), '2026-09-14T03:00:00.000Z');
  // New York shifts on 8 March 2026: the same wall clock is a different instant either side.
  assert.equal(new Date(instantOfLocal('2026-03-07', 10 * 60, 'America/New_York')!).toISOString(), '2026-03-07T15:00:00.000Z');
  assert.equal(new Date(instantOfLocal('2026-03-09', 10 * 60, 'America/New_York')!).toISOString(), '2026-03-09T14:00:00.000Z');
  // 02:30 on the spring-forward morning does not exist.
  assert.equal(instantOfLocal('2026-03-08', 2 * 60 + 30, 'America/New_York'), null);
  // The repeated hour in autumn resolves to one real instant, not a crash.
  assert.ok(instantOfLocal('2026-11-01', 60 + 30, 'America/New_York'));
});

test('slots respect working hours, duration and the requested window', () => {
  const slots = freeSlots([], { ...base, from: new Date('2026-09-14T00:00:00Z'), to: new Date('2026-09-15T00:00:00Z') });
  assert.deepEqual([local(slots[0].start).weekday, local(slots[0].start).time], ['Mon', '09:00']);
  assert.equal(local(slots.at(-1)!.start).time, '17:30');
  assert.equal(slots.length, 18, 'nine hours at half-hour steps');
  assert.ok(slots.every(slot => new Date(slot.end).getTime() - new Date(slot.start).getTime() === 30 * 60_000));
});

test('weekends and out-of-hours times are never offered', () => {
  const week = freeSlots([], { ...base, from: new Date('2026-09-18T00:00:00Z'), to: new Date('2026-09-22T00:00:00Z') });
  const days = new Set(week.map(slot => local(slot.start).weekday));
  assert.deepEqual([...days].sort(), ['Fri', 'Mon']);
  assert.ok(week.every(slot => local(slot.start).hour >= 9 && local(slot.start).hour < 18));
});

test('busy time is blocked with a buffer on both sides', () => {
  const busy = [{ start: Date.parse('2026-09-14T05:00:00Z'), end: Date.parse('2026-09-14T06:00:00Z') }]; // 11:00-12:00 Dhaka
  const slots = freeSlots(busy, { ...base, from: new Date('2026-09-14T00:00:00Z'), to: new Date('2026-09-15T00:00:00Z') });
  const offered = slots.map(slot => local(slot.start).time);
  // 10:30 would end at 11:00 and 12:00 would start on the hour: the ten minute buffer removes both.
  assert.ok(!offered.includes('10:30') && !offered.includes('11:00') && !offered.includes('11:30') && !offered.includes('12:00'));
  assert.ok(offered.includes('10:00') && offered.includes('12:30'));
});

test('the notice period hides times that are too soon', () => {
  const from = new Date();
  const to = new Date(from.getTime() + 14 * 86_400_000);
  const slots = freeSlots([], { ...base, from, to, noticeMinutes: 12 * 60 });
  const earliest = Date.now() + 12 * 3600_000;
  assert.ok(slots.length, 'a fortnight of weekdays must contain slots');
  assert.ok(slots.every(slot => new Date(slot.start).getTime() >= earliest), 'a slot inside the notice period was offered');
});

test('a working day in a shifting zone keeps its local hours across the change', () => {
  // The next New York transition after this test was written: clocks fall back on 1 November 2026.
  // A past window would be empty, because slots are never offered in the past.
  const slots = freeSlots([], {
    ...base, timeZone: 'America/New_York', stepMinutes: 60,
    from: new Date('2026-10-30T00:00:00Z'), to: new Date('2026-11-03T00:00:00Z'),
  });
  const byDay = new Map<string, string[]>();
  for (const slot of slots) {
    const shown = local(slot.start, 'America/New_York');
    byDay.set(shown.day, [...(byDay.get(shown.day) ?? []), shown.time]);
  }
  // Friday is on standard time, Monday on daylight time: both still start at 09:00 local.
  assert.equal(byDay.get('30/10')?.[0], '09:00', 'the Friday before the change');
  assert.equal(byDay.get('02/11')?.[0], '09:00', 'the Monday after it');
  assert.equal(byDay.get('30/10')?.length, byDay.get('02/11')?.length);
});
