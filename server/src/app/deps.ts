import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type OpenAI from 'openai';
import { verifyTurnstile } from '../turnstile';
import type { Config } from '../config';
import type { Db } from '../db';
import type { Retrieval } from '../retrieval';
import type { Mailer } from '../mailer';
import type { Storage } from '../storage';
import type { EventType, Scheduler } from '../scheduler';
import type { ToolContext } from '../tools';
import type { GenUiComposer } from '../gen-ui';

export type Vars = { clientIP: string; sessionId: string };
export type App = OpenAPIHono<{ Variables: Vars }>;
export type AppOptions = { metricsOrigin?: 'visitor' | 'eval' | 'warmup'; github?: ToolContext['github']; genUi?: GenUiComposer };
export type AppDeps = ReturnType<typeof createDeps>;

// What the route modules share: one per createApp call, so `concurrency` is the same object everywhere.
export function createDeps(config: Config, db: Db, retrieval: Retrieval, mailer: Mailer, storage: Storage, scheduler: Scheduler, client: OpenAI, options: AppOptions) {
  const origin = options.metricsOrigin ?? 'visitor';
  // ponytail: concurrency is per process; size the replica count against the provider's capacity.
  const concurrency = { active: 0 };
  const sessionOf = async (c: Context) => {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header('authorization') ?? '')?.[1];
    return token ? await db.touchSession(token) : null;
  };
  // Null when the visitor passes; otherwise the response to send instead.
  const siteHostname = new URL(config.SITE_ORIGIN).hostname;
  const checkChallenge = async (c: Context, action: 'session' | 'contact') => {
    const verdict = await verifyTurnstile(config.TURNSTILE_SECRET_KEY, c.req.header('x-turnstile-token'), c.get('clientIP'), { action, hostname: siteHostname });
    if (verdict === 'pass') return null;
    if (verdict === 'unavailable') return c.json({ error: 'The bot check is unavailable right now. Please try again in a minute.' }, 503);
    return c.json({ error: 'The bot check did not pass. Reload the page and try again.' }, 403);
  };
  // A bad header must never break a request: fall back to UTC rather than trusting the caller.
  const timeZoneOf = (header?: string) => {
    if (!header || header.length > 64) return 'UTC';
    try { new Intl.DateTimeFormat('en', { timeZone: header }); return header; } catch { return 'UTC'; }
  };
  const availableSlots = async (eventType: EventType, timeZone: string) => {
    const from = new Date();
    const to = new Date(from.getTime() + config.BOOKING_WINDOW_DAYS * 86400000);
    return scheduler.availability(eventType, from, to, timeZone);
  };
  return { config, db, retrieval, mailer, storage, scheduler, client, options, origin, concurrency, sessionOf, checkChallenge, timeZoneOf, availableSlots };
}
