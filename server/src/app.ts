import { createHash } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { apiReference } from '@scalar/hono-api-reference';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { Context, MiddlewareHandler } from 'hono';
import OpenAI from 'openai';
import type { Config } from './config';
import type { Db } from './db';
import { buildSystemPrompt } from './knowledge';
import type { Retrieval, SourceHit } from './retrieval';
import type { Mailer } from './mailer';
import type { Storage } from './storage';
import { AmbiguousBookingError, type EventType, type Scheduler } from './scheduler';
import { buildToolDefinitions, runTool } from './tools';

const MAX_CONTEXT_CHARS = 24000;
// A cached answer is reused when this many of the newest turns, the new question included, match.
const CACHE_TURNS = 5;
// These events carry ids owned by the session that asked, or depend on the clock: never replayed to another.
const SESSION_BOUND_EVENTS = new Set(['draft', 'proposal', 'artifact', 'action', 'slots']);
export const CLIENT_HEADERS = ['Content-Type', 'Authorization', 'X-Time-Zone'];
// An attached image travels as a data URL and is never stored: it is passed to the model for
// this turn only, and later turns carry a note in its place.
const attachmentSchema = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  dataUrl: z.string().max(4_000_000).regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/, 'Attachment must be a base64 image data URL'),
}).strict();
// The browser owns the conversation and sends its recent turns with each question. It is the
// visitor's own transcript, so a forged turn only steers that visitor's answer; every tool that
// reaches the outside world still waits for the visitor's click.
const historySchema = z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(MAX_CONTEXT_CHARS) }).strict()).max(200);
const chatSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  history: historySchema.default([]),
  attachment: attachmentSchema.optional(),
}).strict();
const errorSchema = z.object({ error: z.string() });
const sessionSchema = z.object({ token: z.string(), expiresAt: z.string() });
const sourceSchema = z.object({
  repo: z.string(), path: z.string(), language: z.string(), symbols: z.array(z.string()),
  startLine: z.number(), endLine: z.number(), commit: z.string(), url: z.string(), snippet: z.string(),
}).openapi('SourceCitation');
const actionSchema = z.object({
  id: z.string(), target: z.string(), route: z.string(), anchor: z.string(), label: z.string(), action: z.enum(['reveal', 'contact']),
}).openapi('UiAction');
const draftSchema = z.object({
  id: z.string(), name: z.string(), email: z.string(), message: z.string(), to: z.string(),
}).openapi('ContactDraft');
const artifactSchema = z.object({
  id: z.string(), kind: z.string(), title: z.string(), bytes: z.number(), markdown: z.string(), expiresAt: z.string(),
}).openapi('Artifact');
const slotSchema = z.object({ start: z.string(), end: z.string() }).openapi('Slot');
const slotsSchema = z.object({ timeZone: z.string(), durationMinutes: z.number(), label: z.string(), key: z.string(), slots: z.array(slotSchema) }).openapi('Availability');
const proposalSchema = z.object({
  id: z.string(), start: z.string(), end: z.string(), timeZone: z.string(), durationMinutes: z.number(), label: z.string(), key: z.string(),
  name: z.string(), email: z.string(), notes: z.string(),
}).openapi('BookingProposal');
const usageSchema = z.object({
  ms: z.number(), model: z.string(), promptTokens: z.number().optional(), completionTokens: z.number().optional(), costUsd: z.number().optional(),
  cached: z.boolean().optional().openapi({ description: 'True when a stored answer was replayed instead of generated.' }),
}).openapi('Usage');
const eventSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), type: z.literal('delta'), text: z.string() }),
  z.object({ version: z.literal(1), type: z.literal('tool'), id: z.string(), name: z.string(), summary: z.string(), status: z.enum(['running', 'done', 'error']), ms: z.number().optional() })
    .openapi({ description: 'A real tool execution: emitted when it starts and again when it finishes.' }),
  z.object({ version: z.literal(1), type: z.literal('sources'), sources: z.array(sourceSchema) })
    .openapi({ description: 'Source evidence read while answering, pinned to the indexed commit.' }),
  z.object({ version: z.literal(1), type: z.literal('action'), action: actionSchema })
    .openapi({ description: 'A navigation or highlight the browser should perform, then acknowledge at /v1/actions/{id}.' }),
  z.object({ version: z.literal(1), type: z.literal('image'), image: z.object({ id: z.string(), src: z.string(), alt: z.string(), caption: z.string() }) })
    .openapi({ description: "One of the portfolio's own screenshots, chosen from a closed list." }),
  z.object({ version: z.literal(1), type: z.literal('draft'), draft: draftSchema })
    .openapi({ description: 'An editable message preview. Nothing is sent until the visitor posts it to /v1/contact.' }),
  z.object({ version: z.literal(1), type: z.literal('artifact'), artifact: artifactSchema })
    .openapi({ description: 'A generated document, previewable inline and downloadable through /v1/artifacts/{id}.' }),
  z.object({ version: z.literal(1), type: z.literal('slots'), availability: slotsSchema })
    .openapi({ description: 'Real free slots read from the calendar, for the visitor to pick from.' }),
  z.object({ version: z.literal(1), type: z.literal('proposal'), proposal: proposalSchema })
    .openapi({ description: 'A call awaiting the visitor\'s confirmation at /v1/bookings. Nothing is booked yet.' }),
  z.object({ version: z.literal(1), type: z.literal('usage'), usage: usageSchema })
    .openapi({ description: 'Measured answer latency and the provider-reported token usage, when the provider reports it.' }),
  z.object({ version: z.literal(1), type: z.literal('done'), finishReason: z.enum(['stop', 'length']) }),
  z.object({ version: z.literal(1), type: z.literal('error'), message: z.string() }),
]).openapi('ChatEvent');
const authHeader = z.object({ authorization: z.string().openapi({ description: 'Bearer <session token>', example: 'Bearer abc123' }) });
const authFailure = { 401: { description: 'Missing, unknown or expired session', content: { 'application/json': { schema: errorSchema } } } };
const guardFailures = {
  403: { description: 'Disallowed origin', content: { 'application/json': { schema: errorSchema } } },
  429: { description: 'Rate, concurrency or daily budget limit', content: { 'application/json': { schema: errorSchema } } },
};

type Vars = { clientIP: string; sessionId: string };

export function createApp(config: Config, db: Db, retrieval: Retrieval, mailer: Mailer, storage: Storage, scheduler: Scheduler, client = new OpenAI({ apiKey: config.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 0 })) {
  const app = new OpenAPIHono<{ Variables: Vars }>({ defaultHook: (result, c) => {
    if (!result.success) return c.json({ error: 'Invalid request. Send one non-empty message under 8000 characters with a valid session.' }, 400);
  } });
  // The per-minute burst limit is per process. The daily budget lives in the database.
  // Put a shared limiter in front (or in the proxy) before running more than one replica.
  const limits = new Map<string, { count: number; expires: number }>();
  let active = 0;
  const sessionOf = async (c: Context) => {
    const token = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '')?.[1];
    return token ? await db.touchSession(token) : null;
  };
  // One fixed window per address, oldest entries dropped on the way past.
  const window = (buckets: Map<string, { count: number; expires: number }>, ip: string, ms: number) => {
    const now = Date.now();
    for (const [key, value] of buckets) if (value.expires <= now) buckets.delete(key);
    const bucket = buckets.get(ip) || { count: 0, expires: now + ms };
    buckets.set(ip, bucket);
    return bucket;
  };

  // Every header the browser client sends must be listed, or the preflight kills the request.
  app.use('*', cors({ origin: config.SITE_ORIGIN, allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowHeaders: CLIENT_HEADERS }));
  // Large enough for a downscaled image attachment, small enough to bound the upload.
  app.use('/v1/*', bodyLimit({ maxSize: 6_000_000, onError: c => c.json({ error: 'Request is too large' }, 413) }));
  app.use('/v1/*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    if (c.req.header('origin') !== config.SITE_ORIGIN) return c.json({ error: 'Origin is not allowed' }, 403);
    const limit = window(limits, c.get('clientIP') || 'unknown', 60000);
    if (++limit.count > config.REQUESTS_PER_MINUTE) return c.json({ error: 'Too many requests from this address. Please try again shortly.' }, 429);
    await next();
  });
  // The token is the only proof of ownership: a guessed or expired one reads and writes nothing.
  const authenticate: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
    const sessionId = await sessionOf(c);
    if (!sessionId) return c.json({ error: 'Session is missing or expired. Start a new conversation.' }, 401);
    c.set('sessionId', sessionId);
    await next();
  };
  for (const path of ['/v1/chat', '/v1/actions/*', '/v1/artifacts/*', '/v1/repos', '/v1/repos/*', '/v1/bookings', '/v1/proposals']) app.use(path, authenticate);

  app.openapi(createRoute({ method: 'get', path: '/health', responses: { 200: { description: 'Process is running', content: { 'application/json': { schema: z.object({ status: z.literal('ok') }) } } } } }),
    c => c.json({ status: 'ok' as const }));

  app.openapi(createRoute({
    method: 'post', path: '/v1/sessions', summary: 'Start an anonymous conversation',
    description: 'Returns a bearer token identifying one anonymous conversation. Store it client-side and send it on every /v1 call. Expiry slides forward on each use; after that the session and what it owns are deleted. Conversations are not stored on the server.',
    responses: { 201: { description: 'Session created', content: { 'application/json': { schema: sessionSchema } } }, ...guardFailures },
  }), async c => c.json(await db.createSession(), 201));

  app.openapi(createRoute({
    method: 'post', path: '/v1/chat', summary: 'Stream a portfolio answer',
    description: 'Requires the configured site Origin and a session bearer token. The browser keeps the conversation and sends its recent turns as history; the server keeps the newest MAX_MESSAGES_PER_SESSION turns and trims the oldest to fit the context budget. When the last five turns, model, prompt and indexed commits match a finished answer from the last ANSWER_CACHE_TTL_HOURS, that answer is replayed with usage.cached set, without calling the model or spending the daily budget. An optional image attachment is passed to the model for this turn only. POST using fetch; SSE data is one JSON ChatEvent per frame, and a done or error event terminates the response. OpenAPI describes each event, not the whole stream.',
    request: { headers: authHeader, body: { required: true, content: { 'application/json': { schema: chatSchema } } } },
    responses: {
      200: { description: 'SSE frames containing versioned ChatEvent JSON', content: { 'text/event-stream': { schema: eventSchema } } },
      400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
      413: { description: 'Body too large', content: { 'application/json': { schema: errorSchema } } },
      ...authFailure, ...guardFailures,
    },
  }), async c => {
    const { message, history: sent, attachment } = c.req.valid('json');
    const sessionId = c.get('sessionId');
    const history = sent.slice(-config.MAX_MESSAGES_PER_SESSION);
    while (history.length && history.reduce((sum, entry) => sum + entry.content.length, message.length) > MAX_CONTEXT_CHARS) history.splice(0, 2);
    const indexed = await retrieval.indexedRepos().catch(() => []);
    const systemPrompt = buildSystemPrompt(indexed, mailer.configured, storage.configured, scheduler.configured ? scheduler.eventTypes : []);
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('X-Accel-Buffering', 'no');

    // The same last turns against the same model, prompt and indexed commits get the same answer, so
    // it is replayed instead of generated. A reindex or prompt change moves the key and misses on its own.
    const cacheKey = attachment || !config.ANSWER_CACHE_TTL_HOURS ? undefined : createHash('sha256').update(JSON.stringify({
      model: config.OPENROUTER_MODEL, system: systemPrompt,
      commits: indexed.map(entry => `${entry.repo}@${entry.commit}`),
      turns: [...history, { role: 'user', content: message }].slice(-CACHE_TURNS).map(({ role, content }) => [role, content]),
    })).digest();
    const cached = cacheKey && await db.cachedAnswer(cacheKey).catch(() => undefined);
    // A replay costs no model call, so it spends neither the daily budget nor a concurrency slot.
    if (cached) return streamSSE(c, async stream => {
      const startedAt = Date.now();
      for (const event of cached) await stream.writeSSE({ data: JSON.stringify({ version: 1, ...event }) });
      await stream.writeSSE({ data: JSON.stringify({ version: 1, type: 'usage', usage: { ms: Date.now() - startedAt, model: config.OPENROUTER_MODEL, cached: true } }) });
      await stream.writeSSE({ data: JSON.stringify({ version: 1, type: 'done', finishReason: 'stop' }) });
    });

    if (active >= config.MAX_CONCURRENT_REQUESTS) return c.json({ error: 'Assistant is busy. Please try again shortly.' }, 429);
    if (!await db.reserveDailyRequest(config.MAX_REQUESTS_PER_DAY)) return c.json({ error: 'The assistant’s daily request budget is spent. Please try tomorrow.' }, 429);
    active++;
    return streamSSE(c, async stream => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
      stream.onAbort(() => controller.abort());
      // Every event is recorded while it may still be cached; a session-bound event or a failed tool rules it out.
      let recorded: Record<string, unknown>[] | undefined = cacheKey ? [] : undefined;
      const send = (event: Record<string, unknown>) => {
        if (recorded && SESSION_BOUND_EVENTS.has(String(event.type))) recorded = undefined;
        recorded?.push(event);
        return stream.writeSSE({ data: JSON.stringify({ version: 1, ...event }) });
      };
      const conversation: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...history.map(entry => ({ role: entry.role, content: entry.content })),
        attachment
          ? { role: 'user' as const, content: [{ type: 'text' as const, text: message }, { type: 'image_url' as const, image_url: { url: attachment.dataUrl } }] }
          : { role: 'user' as const, content: message },
      ];
      const visitorTimeZone = timeZoneOf(c.req.header('x-time-zone'));
      const repoNames = indexed.map(entry => entry.repo);
      const toolDefinitions = buildToolDefinitions(repoNames);
      const toolContext = {
        retrieval, repoNames, contactEnabled: mailer.configured, artifactsEnabled: storage.configured, maxArtifactBytes: config.ARTIFACT_MAX_BYTES,
        scheduling: scheduler.configured
          ? { timeZone: visitorTimeZone, eventTypes: scheduler.eventTypes, availability: (eventType: EventType) => availableSlots(eventType, visitorTimeZone) }
          : undefined,
      };
      const sources: SourceHit[] = [];
      let answer = '';
      const startedAt = Date.now();
      const usage: { promptTokens?: number; completionTokens?: number; costUsd?: number } = {};
      try {
        let finish: string | null = null;
        for (let step = 0; step <= config.MAX_TOOL_STEPS; step++) {
          // The last step runs without tools so the model must produce an answer instead of another call.
          const canUseTools = step < config.MAX_TOOL_STEPS;
          const response = await client.chat.completions.create({
            model: config.OPENROUTER_MODEL, messages: conversation, stream: true, max_tokens: config.MAX_OUTPUT_TOKENS,
            stream_options: { include_usage: true },
            ...(canUseTools ? { tools: toolDefinitions, tool_choice: 'auto' as const } : {}),
          }, { signal: controller.signal });

          const calls: { id: string; name: string; arguments: string }[] = [];
          let stepText = '';
          finish = null;
          for await (const chunk of response) {
            if ('error' in chunk) throw new Error('Provider stream error');
            // Only what the provider actually reports: no estimates, no invented numbers.
            if (chunk.usage) {
              usage.promptTokens = (usage.promptTokens ?? 0) + (chunk.usage.prompt_tokens ?? 0);
              usage.completionTokens = (usage.completionTokens ?? 0) + (chunk.usage.completion_tokens ?? 0);
              const cost = (chunk.usage as { cost?: number }).cost;
              if (typeof cost === 'number') usage.costUsd = (usage.costUsd ?? 0) + cost;
            }
            const choice = chunk.choices[0];
            if (choice?.delta?.content) {
              stepText += choice.delta.content;
              answer += choice.delta.content;
              await send({ type: 'delta', text: choice.delta.content });
            }
            // Ignore tool calls on the final step: no tools were offered, so any are spurious.
            for (const part of (canUseTools ? choice?.delta?.tool_calls : undefined) ?? []) {
              const call = calls[part.index] ??= { id: '', name: '', arguments: '' };
              if (part.id) call.id = part.id;
              if (part.function?.name) call.name += part.function.name;
              if (part.function?.arguments) call.arguments += part.function.arguments;
            }
            if (choice?.finish_reason) finish = choice.finish_reason;
          }

          const requested = calls.filter(call => call?.name);
          if (!requested.length) break;
          conversation.push({ role: 'assistant', content: stepText || null, tool_calls: requested.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) });
          for (const call of requested) {
            const started = Date.now();
            await send({ type: 'tool', id: call.id, name: call.name, summary: 'running', status: 'running' });
            let outcome;
            try { outcome = await runTool(toolContext, call.name, call.arguments); }
            catch (error) {
              console.error('Tool failed:', call.name, error instanceof Error ? error.message : error);
              outcome = { summary: 'tool failed', result: 'The tool could not run. Say so instead of guessing.', sources: [], failed: true as const };
            }
            const ms = Date.now() - started;
            if (outcome.failed) recorded = undefined;
            await send({ type: 'tool', id: call.id, name: call.name, summary: outcome.summary, status: outcome.summary.startsWith('tool failed') ? 'error' : 'done', ms });
            if (outcome.image) await send({ type: 'image', image: outcome.image });
            if (outcome.slots) {
              const { eventType, timeZone, slots: free } = outcome.slots;
              await send({ type: 'slots', availability: { timeZone, durationMinutes: eventType.minutes, label: eventType.label, key: eventType.key, slots: free } });
            }
            if (outcome.proposal) {
              const { eventType, start, name, email, notes } = outcome.proposal;
              const id = await db.createBooking({ sessionId, meetingKey: eventType.key, slotStart: start, name, email, timeZone: visitorTimeZone, notes }, config.BOOKING_TTL_MINUTES);
              const proposal = {
                id, start, end: new Date(new Date(start).getTime() + eventType.minutes * 60000).toISOString(),
                timeZone: visitorTimeZone, durationMinutes: eventType.minutes, label: eventType.label, key: eventType.key, name, email, notes,
              };
              await send({ type: 'proposal', proposal });
            }
            if (outcome.artifact) {
              const { kind, title } = outcome.artifact;
              const id = crypto.randomUUID();
              // The key is built from ids this server generated, so a title can never shape the path.
              const objectKey = `artifacts/${sessionId}/${id}.md`;
              const document = `# ${title}\n\n${outcome.artifact.markdown}\n\n---\nGenerated by the assistant on soyebjim.me. Source citations point at the indexed commit.\n`;
              const bytes = Buffer.byteLength(document, 'utf8');
              try {
                await storage.put(objectKey, document, 'text/markdown; charset=utf-8');
                await db.createArtifact({ id, sessionId, kind, title, objectKey, bytes, sources }, config.ARTIFACT_TTL_DAYS);
                const artifact = { id, kind, title, bytes, markdown: document, expiresAt: new Date(Date.now() + config.ARTIFACT_TTL_DAYS * 86400000).toISOString() };
                await send({ type: 'artifact', artifact });
              } catch (error) {
                console.error('Could not store artifact:', error instanceof Error ? error.message : error);
                conversation.push({ role: 'tool', tool_call_id: call.id, content: 'The document could not be stored. Tell the visitor it is unavailable and answer in the chat instead.' });
                continue;
              }
            }
            if (outcome.draft) {
              const draftId = await db.createDraft(sessionId, outcome.draft, config.CONTACT_DRAFT_TTL_MINUTES);
              await send({ type: 'draft', draft: { id: draftId, ...outcome.draft, to: mailer.recipientLabel } });
            }
            if (outcome.action) {
              const actionId = crypto.randomUUID();
              // Recorded before it is sent so an acknowledgement always has a row to update.
              await db.recordAction(actionId, sessionId, outcome.action.target).catch(error => console.error('Could not record action:', error.message));
              await send({ type: 'action', action: { id: actionId, ...outcome.action } });
            }
            for (const hit of outcome.sources) {
              // Drop a range already covered by a wider citation of the same file, and replace the
              // narrower one when this hit covers it: overlapping windows are one piece of evidence.
              const sameFile = (other: SourceHit) => other.repo === hit.repo && other.path === hit.path;
              if (sources.some(existing => sameFile(existing) && existing.startLine <= hit.startLine && existing.endLine >= hit.endLine)) continue;
              const covered = sources.filter(existing => sameFile(existing) && existing.startLine >= hit.startLine && existing.endLine <= hit.endLine);
              for (const narrower of covered) sources.splice(sources.indexOf(narrower), 1);
              sources.push(hit);
            }
            conversation.push({ role: 'tool', tool_call_id: call.id, content: outcome.result });
          }
          if (sources.length) await send({ type: 'sources', sources });
        }
        if (finish !== 'stop' && finish !== 'length') throw new Error('Incomplete provider response');
        if (!answer.trim()) throw new Error('Empty provider response');
        // Only a whole answer is reused; one cut off at the length limit is not.
        if (cacheKey && recorded && finish === 'stop') {
          await db.cacheAnswer(cacheKey, recorded, config.ANSWER_CACHE_TTL_HOURS).catch(error => console.error('Could not cache answer:', error.message));
        }
        await send({ type: 'usage', usage: { ms: Date.now() - startedAt, model: config.OPENROUTER_MODEL, ...usage } });
        await send({ type: 'done', finishReason: finish });
      } catch {
        if (!stream.aborted) await send({ type: 'error', message: controller.signal.aborted ? 'Response timed out. Please retry.' : 'The model could not finish this answer. Please retry.' });
      } finally { clearTimeout(timer); controller.abort(); active--; }
    });
  });

  app.openapi(createRoute({
    method: 'post', path: '/v1/actions/{id}', summary: 'Acknowledge a requested UI action',
    description: 'The browser reports what actually happened: done, missing when the target was not on the page, failed otherwise. Only the session that requested the action can acknowledge it, and only once.',
    request: {
      headers: authHeader,
      params: z.object({ id: z.string().uuid() }),
      body: { required: true, content: { 'application/json': { schema: z.object({ status: z.enum(['done', 'missing', 'failed']) }).strict() } } },
    },
    responses: {
      204: { description: 'Acknowledged' },
      404: { description: 'No such pending action for this session', content: { 'application/json': { schema: errorSchema } } },
      400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
      ...authFailure, ...guardFailures,
    },
  }), async c => {
    const acknowledged = await db.acknowledgeAction(c.req.valid('param').id, c.get('sessionId'), c.req.valid('json').status);
    return acknowledged ? c.body(null, 204) : c.json({ error: 'That action is not pending for this session.' }, 404);
  });

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

  // The per-address hourly send limit is per process. The daily cap lives in the database.
  const sendLimits = new Map<string, { count: number; expires: number }>();
  const contactBody = z.object({
    draftId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(200),
    message: z.string().trim().min(10).max(4000),
    _gotcha: z.string().max(200).optional(),
  }).strict();

  app.openapi(createRoute({
    method: 'post', path: '/v1/contact', summary: 'Send a message to Jim',
    description: 'The only path to the email provider, and it is never reached by the model: the visitor posts the exact text they approved. With draftId the draft must belong to the caller\'s session, and posting the same draft again returns the first result instead of sending twice. Without draftId this is the plain contact form. A 202 means the provider accepted the message, not that it reached the inbox.',
    request: { body: { required: true, content: { 'application/json': { schema: contactBody } } } },
    responses: {
      202: { description: 'Accepted by the email provider', content: { 'application/json': { schema: z.object({ id: z.string(), status: z.enum(['accepted', 'already-sent']) }) } } },
      400: { description: 'Invalid message', content: { 'application/json': { schema: errorSchema } } },
      401: { description: 'A draft was named but the session is missing or expired', content: { 'application/json': { schema: errorSchema } } },
      403: { description: 'Disallowed origin', content: { 'application/json': { schema: errorSchema } } },
      404: { description: 'No such draft for this session', content: { 'application/json': { schema: errorSchema } } },
      429: { description: 'Send limit reached', content: { 'application/json': { schema: errorSchema } } },
      502: { description: 'The email provider rejected the message; the draft is kept', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Email delivery is not configured', content: { 'application/json': { schema: errorSchema } } },
    },
  }), async c => {
    if (!mailer.configured) return c.json({ error: 'Email delivery is not configured on this server.' }, 503);
    const body = c.req.valid('json');
    // Silently accept the honeypot: a bot learns nothing from the response.
    if (body._gotcha) return c.json({ id: '', status: 'accepted' as const }, 202);

    const limit = window(sendLimits, c.get('clientIP') || 'unknown', 3600000);
    // Counted only when a message actually goes out, so a rejected draft never costs the visitor a send.
    if (limit.count >= config.CONTACT_SENDS_PER_HOUR) return c.json({ error: 'Too many messages from this address. Please try again later.' }, 429);

    const draft = { name: body.name, email: body.email, message: body.message };
    let draftId = body.draftId;
    if (draftId) {
      const sessionId = await sessionOf(c);
      if (!sessionId) return c.json({ error: 'Session is missing or expired. Start a new conversation.' }, 401);
      const claim = await db.claimDraft(draftId, sessionId, draft);
      if (!claim.claimed) {
        if (claim.status === 'sent') return c.json({ id: draftId, status: 'already-sent' as const }, 202);
        return c.json({ error: 'That draft is no longer available. Write the message again.' }, 404);
      }
    } else {
      draftId = await db.createDirectDraft(draft, config.CONTACT_DRAFT_TTL_MINUTES);
    }

    if (!await db.reserveContactSend(config.CONTACT_SENDS_PER_DAY)) return c.json({ error: 'The daily message limit is reached. Please email directly.' }, 429);
    limit.count++;
    try {
      const providerId = await mailer.send({ name: draft.name, email: draft.email, body: draft.message });
      await db.finishDraft(draftId, 'sent', providerId);
      return c.json({ id: draftId, status: 'accepted' as const }, 202);
    } catch (error) {
      // Keep the draft so the visitor can retry the same text, and free the reserved slot.
      console.error('Contact delivery failed:', error instanceof Error ? error.message : error);
      await db.finishDraft(draftId, 'failed').catch(() => {});
      await db.releaseContactSend().catch(() => {});
      return c.json({ error: 'The message could not be delivered. Your text is kept, please try again.' }, 502);
    }
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/artifacts/{id}', summary: 'Get a download link for a generated document',
    description: 'Returns a short-lived signed URL for an artifact belonging to the caller\'s session. The object itself is private, so the link is the only way to read it and it expires within minutes.',
    request: { headers: authHeader, params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: { description: 'Signed download link', content: { 'application/json': { schema: z.object({ url: z.string(), title: z.string(), expiresInSeconds: z.number() }) } } },
      404: { description: 'No such artifact for this session', content: { 'application/json': { schema: errorSchema } } },
      503: { description: 'Artifact storage is not configured', content: { 'application/json': { schema: errorSchema } } },
      ...authFailure, ...guardFailures,
    },
  }), async c => {
    if (!storage.configured) return c.json({ error: 'Artifact storage is not configured on this server.' }, 503);
    const artifact = await db.findArtifact(c.req.valid('param').id, c.get('sessionId'));
    if (!artifact) return c.json({ error: 'That document is not available.' }, 404);
    const url = await storage.signedUrl(artifact.object_key, config.ARTIFACT_URL_TTL_SECONDS);
    return c.json({ url, title: artifact.title, expiresInSeconds: config.ARTIFACT_URL_TTL_SECONDS }, 200);
  });

  const repoCard = z.object({
    repo: z.string(), description: z.string(), language: z.string(), topics: z.array(z.string()),
    stars: z.number(), openIssues: z.number(), url: z.string(), pushedAt: z.string(), commit: z.string(),
    files: z.number(), chunks: z.number(), edges: z.number(),
  }).openapi('RepoCard');

  app.openapi(createRoute({
    method: 'get', path: '/v1/repos', summary: 'Every indexed repository with its facts',
    description: 'Powers the repository overview: what is indexed, how large, how recently pushed, and how many dependency edges were parsed. Read-only and identical for every visitor.',
    request: { headers: authHeader },
    responses: { 200: { description: 'Indexed repositories', content: { 'application/json': { schema: z.object({ repos: z.array(repoCard) }) } } }, ...authFailure, ...guardFailures },
  }), async c => c.json({ repos: await retrieval.repoCards() }, 200));

  app.openapi(createRoute({
    method: 'get', path: '/v1/repos/{repo}/files', summary: 'The indexed file list of one repository',
    request: { headers: authHeader, params: z.object({ repo: z.string() }) },
    responses: {
      200: { description: 'File list', content: { 'application/json': { schema: z.object({
        repo: z.string(), commit: z.string(), url: z.string(),
        files: z.array(z.object({ path: z.string(), lines: z.number(), language: z.string() })),
      }) } } },
      404: { description: 'Not indexed', content: { 'application/json': { schema: errorSchema } } },
      ...authFailure, ...guardFailures,
    },
  }), async c => {
    const tree = await retrieval.fileTree(c.req.valid('param').repo);
    return tree ? c.json(tree, 200) : c.json({ error: 'That repository is not indexed.' }, 404);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/repos/{repo}/file', summary: 'One indexed file, for reading in the panel',
    description: 'Returns the stored copy of a file at the indexed commit, capped at 2000 lines. Only files that were indexed exist here, so a path outside the repository returns 404.',
    request: { headers: authHeader, params: z.object({ repo: z.string() }), query: z.object({ path: z.string().min(1).max(400) }) },
    responses: {
      200: { description: 'File content', content: { 'application/json': { schema: z.object({
        repo: z.string(), path: z.string(), language: z.string(), commit: z.string(),
        lineCount: z.number(), truncated: z.boolean(), url: z.string(), content: z.string(),
      }) } } },
      404: { description: 'No such indexed file', content: { 'application/json': { schema: errorSchema } } },
      ...authFailure, ...guardFailures,
    },
  }), async c => {
    const file = await retrieval.readFile(c.req.valid('param').repo, c.req.valid('query').path);
    return file ? c.json(file, 200) : c.json({ error: 'That file is not in the indexed revision.' }, 404);
  });

  app.openapi(createRoute({
    method: 'get', path: '/v1/repos/{repo}/graph', summary: 'Module dependency graph of one repository',
    description: 'Directories collapsed into modules, with edge weights counted from imports and includes parsed at index time. Nothing here is inferred by a model.',
    request: { headers: authHeader, params: z.object({ repo: z.string() }) },
    responses: {
      200: { description: 'Module graph', content: { 'application/json': { schema: z.object({
        repo: z.string(), commit: z.string(), edgeCount: z.number(), moduleCount: z.number(), truncated: z.boolean(),
        nodes: z.array(z.object({ id: z.string(), files: z.number(), lines: z.number() })),
        edges: z.array(z.object({ from: z.string(), to: z.string(), weight: z.number() })),
      }) } } },
      404: { description: 'Not indexed', content: { 'application/json': { schema: errorSchema } } },
      ...authFailure, ...guardFailures,
    },
  }), async c => {
    const graph = await retrieval.graph(c.req.valid('param').repo);
    return graph ? c.json(graph, 200) : c.json({ error: 'That repository is not indexed.' }, 404);
  });

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
    try {
      const { uid } = await scheduler.book({ eventTypeKey: eventType.key, start, name: body.name, email: body.email, timeZone, notes: '' });
      await db.finishBooking(body.proposalId, 'confirmed', uid);
      return c.json({ id: body.proposalId, uid, start, status: 'confirmed' as const }, 201);
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
  });

  app.doc('/openapi.json', { openapi: '3.1.0', info: { title: 'Portfolio Assistant API', version: '0.2.0' } });
  app.get('/docs', apiReference({ url: '/openapi.json' }));
  app.onError((error, c) => {
    if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON' }, 400);
    console.error('Unhandled request error:', error.message);
    return c.json({ error: 'Request could not be processed' }, 500);
  });
  return app;
}
