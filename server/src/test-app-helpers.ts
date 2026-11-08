import assert from 'node:assert/strict';
import { after, beforeEach } from 'node:test';
import OpenAI from 'openai';
import { createApp } from './app';
import { configSchema } from './config';
import { createDb, type Db } from './db';
import type { Retrieval, SourceHit } from './retrieval';
import type { Mailer } from './mailer';
import type { Storage } from './storage';
import type { Scheduler, Slot } from './scheduler';
import { Pool } from 'pg';

// TEST_DATABASE_URL only, never DATABASE_URL: these tests TRUNCATE every table.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database. These tests delete all rows, so never point it at a database you care about.');
export const config = configSchema.parse({ OPENROUTER_API_KEY: 'test-key', OPENROUTER_MODEL: 'test-model', SITE_ORIGIN: 'http://localhost:4321', DATABASE_URL: url, MAX_MESSAGES_PER_SESSION: 4, ANSWER_CACHE_TTL_HOURS: 0, REQUESTS_PER_MINUTE: 100 });
// The answer cache is off by default here so repeated questions keep reaching the provider; its own tests turn it on.
export const cachedConfig = { ...config, ANSWER_CACHE_TTL_HOURS: 24 };
export const db: Db = await createDb(url, config.SESSION_TTL_DAYS);
export const pool = new Pool({ connectionString: url });
after(async () => { await db.close(); await pool.end(); });
beforeEach(async () => { sentMail.length = 0; stored.clear(); booked.length = 0; await pool.query('TRUNCATE sessions, usage_daily, answer_cache, rate_limits, answer_metrics CASCADE'); });

export const hit = (overrides: Partial<SourceHit> = {}): SourceHit => ({
  repo: 'hyprfm', path: 'src/FileOps.cpp', language: 'cpp', symbols: ['copy'], startLine: 10, endLine: 40,
  commit: 'a'.repeat(40), url: 'https://github.com/soyeb-jim285/hyprfm/blob/' + 'a'.repeat(40) + '/src/FileOps.cpp#L10-L40',
  snippet: 'void FileOps::copy() {}', ...overrides,
});
// Fake index: the retrieval layer itself is covered in retrieval.test.ts against a real database.
export const fakeRetrieval = (overrides: Partial<Retrieval> = {}) => ({
  indexedRepos: async () => [{ repo: 'hyprfm', commit: 'a'.repeat(40), files: 12, chunks: 40, indexedAt: '2026-09-11T00:00:00.000Z', blurb: 'file manager', stars: 307, language: 'C++', pushedAt: '2026-09-10T00:00:00.000Z' }],
  search: async () => [hit()],
  read: async () => ({ repo: 'hyprfm', path: 'src/FileOps.cpp', language: 'cpp', commit: 'a'.repeat(40), startLine: 10, endLine: 40, lineCount: 120, url: hit().url, content: 'void FileOps::copy() {}' }),
  listFiles: async () => [{ path: 'src/FileOps.cpp', lines: 120 }],
  ...overrides,
} as Retrieval);
export const sentMail: { name: string; email: string; body: string }[] = [];
export const fakeMailer = (overrides: Partial<Mailer> = {}): Mailer => ({
  configured: true, recipientLabel: 'Jim',
  async send(message) { sentMail.push(message); return `mail_${sentMail.length}`; },
  ...overrides,
});
export const stored = new Map<string, string>();
export const fakeStorage = (overrides: Partial<Storage> = {}): Storage => ({
  configured: true,
  async put(key, body) { stored.set(key, body); },
  async signedUrl(key, seconds) { return `https://bucket.example/${key}?X-Amz-Expires=${seconds}&X-Amz-Signature=abc`; },
  async remove(keys) { for (const key of keys) stored.delete(key); },
  ...overrides,
});
// Two fixed slots tomorrow, so availability is deterministic in tests.
export const slotAt = (hoursFromNow: number): Slot => {
  const start = new Date(Date.now() + hoursFromNow * 3600000);
  start.setUTCSeconds(0, 0); start.setUTCMinutes(0);
  return { start: start.toISOString(), end: new Date(start.getTime() + 1800000).toISOString() };
};
export const booked: { eventTypeKey: string; start: string; name: string; email: string; timeZone: string }[] = [];
const eventTypes = [
  { minutes: 30, label: 'Intro call', key: '30min' },
  { minutes: 15, label: 'Quick chat', key: '15min' },
];
export const fakeScheduler = (overrides: Partial<Scheduler> = {}): Scheduler => ({
  configured: true, eventTypes,
  async availability(eventType) { return eventType.minutes === 15 ? [slotAt(30)] : [slotAt(24), slotAt(26)]; },
  async book(input) { booked.push({ eventTypeKey: input.eventTypeKey, start: input.start, name: input.name, email: input.email, timeZone: input.timeZone }); return { uid: `event_${booked.length}` }; },
  ...overrides,
});
export const sse = (text: string, finish: string | null = 'stop') => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
export const mockClient = (fetch: typeof globalThis.fetch) => new OpenAI({ apiKey: 'test-key', maxRetries: 0, fetch });
export const replying = (text = 'HyprFM uses Qt.') => { const sent: { body?: any } = {}; return { sent, client: mockClient(async (_url, init) => { sent.body = JSON.parse(String(init?.body)); return new Response(sse(text), { headers: { 'Content-Type': 'text/event-stream' } }); }) }; };
export const ask = (token: string | undefined, message = 'Tell me about HyprFM', origin = config.SITE_ORIGIN, history?: unknown) => new Request('http://localhost/v1/chat', {
  method: 'POST', body: JSON.stringify({ message, history }),
  headers: { 'Content-Type': 'application/json', Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
});
export const newSession = async (app: ReturnType<typeof createApp>) => {
  const response = await app.fetch(new Request('http://localhost/v1/sessions', { method: 'POST', headers: { Origin: config.SITE_ORIGIN } }));
  assert.equal(response.status, 201);
  return (await response.json()).token as string;
};

export const toolFrame = (calls: { index: number; id?: string; name?: string; args?: string }[], finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls.map(call => ({ index: call.index, id: call.id, type: 'function', function: { name: call.name, arguments: call.args } })) }, finish_reason: finish }] })}\n\n`;
export const scripted = (...responses: string[]) => {
  const sent: any[] = [];
  let turn = 0;
  return { sent, client: mockClient(async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(responses[Math.min(turn++, responses.length - 1)], { headers: { 'Content-Type': 'text/event-stream' } });
  }) };
};
export const events = (body: string) => body.split(/\n\n/).filter(Boolean).map(frame => JSON.parse(frame.replace(/^data: /, '')));

export const draftCall = (args: string) => toolFrame([{ index: 0, id: 'call_draft', name: 'prepare_contact', args }], 'tool_calls') + 'data: [DONE]\n\n';

export const availabilityCall = toolFrame([{ index: 0, id: 'call_slots', name: 'get_availability', args: '{}' }], 'tool_calls') + 'data: [DONE]\n\n';
export const proposeCall = (start: string) => toolFrame([{ index: 0, id: 'call_book', name: 'propose_booking', args: JSON.stringify({ start, name: 'Ada', email: 'ada@example.com', notes: 'Qt work' }) }], 'tool_calls') + 'data: [DONE]\n\n';
export const confirmRequest = (app: ReturnType<typeof createApp>, token: string, body: unknown) => app.fetch(new Request('http://localhost/v1/bookings', {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', Origin: config.SITE_ORIGIN, Authorization: `Bearer ${token}` },
}));
export const askInZone = (token: string, message: string, zone: string) => new Request('http://localhost/v1/chat', {
  method: 'POST', body: JSON.stringify({ message }),
  headers: { 'Content-Type': 'application/json', Origin: config.SITE_ORIGIN, Authorization: `Bearer ${token}`, 'X-Time-Zone': zone },
});
