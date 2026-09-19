import { createHash } from 'node:crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { apiReference } from '@scalar/hono-api-reference';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { verifyTurnstile } from './turnstile';
import { streamSSE } from 'hono/streaming';
import type { Context, MiddlewareHandler } from 'hono';
import OpenAI, { toFile } from 'openai';
import type { Config } from './config';
import type { Db } from './db';
import { buildSystemPrompt } from './knowledge';
import type { Retrieval, SourceHit } from './retrieval';
import { AmbiguousDeliveryError, type Mailer } from './mailer';
import type { Storage } from './storage';
import { AmbiguousBookingError, type EventType, type Scheduler, type Slot } from './scheduler';
import { buildToolDefinitions, runTool, type ToolContext, type ToolOutcome } from './tools';

const MAX_CONTEXT_CHARS = 24000;
// However lively the stream, one answer never runs longer than this.
const MAX_ANSWER_MS = 300000;
// Cache replays are paced like a fast stream (see the replay branch of /v1/chat).
const REPLAY_MIN_MS = 350;
const REPLAY_MAX_MS = 1200;
const REPLAY_MS_PER_CHAR = 0.8;
const REPLAY_TOOL_PAUSE_MS = 120;
// These events carry ids owned by the session that asked, or depend on the clock: never replayed to another.
const SESSION_BOUND_EVENTS = new Set(['draft', 'proposal', 'artifact', 'action', 'slots']);
export const CLIENT_HEADERS = ['Content-Type', 'Authorization', 'X-Time-Zone', 'X-Turnstile-Token'];
// A voice note travels as a base64 data URL, is transcribed once and never stored: the browser
// keeps the audio and the text, and only the text ever reaches the chat model.
const AUDIO_FORMATS: Record<string, string> = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/flac': 'flac',
};
const transcribeSchema = z.object({
  mediaType: z.string().regex(/^audio\/[a-z0-9.+-]+(;\s*codecs=[a-z0-9.," -]+)?$/i, 'mediaType must be an audio type'),
  dataUrl: z.string().max(12_000_000).regex(/^data:audio\/[a-z0-9.+-]+(;\s*codecs=[^;,]+)?;base64,[A-Za-z0-9+/=]+$/i, 'Send a base64 audio data URL'),
}).strict();
const transcriptSchema = z.object({
  text: z.string(), seconds: z.number().optional(), costUsd: z.number().optional(), model: z.string(),
}).openapi('Transcript');
// The browser owns the conversation and sends its recent turns with each question. It is the
// visitor's own transcript, so a forged turn only steers that visitor's answer; every tool that
// reaches the outside world still waits for the visitor's click.
const historySchema = z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(MAX_CONTEXT_CHARS) }).strict()).max(200);
const chatSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  history: historySchema.default([]),
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
// A 403 here is a failed check; the 503 is Cloudflare being unreachable, which fails closed.
const challengeFailures = {
  503: { description: 'The bot check could not be reached', content: { 'application/json': { schema: errorSchema } } },
};
const guardFailures = {
  403: { description: 'Disallowed origin', content: { 'application/json': { schema: errorSchema } } },
  429: { description: 'Rate, concurrency or daily budget limit', content: { 'application/json': { schema: errorSchema } } },
};

type Vars = { clientIP: string; sessionId: string };

// metricsOrigin labels every metric this app instance records: the public app says 'visitor', while the
// eval and the cache warm-up build their own instances, so no request header can relabel traffic.
export function createApp(config: Config, db: Db, retrieval: Retrieval, mailer: Mailer, storage: Storage, scheduler: Scheduler, client = new OpenAI({ apiKey: config.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 0 }),
  options: { metricsOrigin?: 'visitor' | 'eval' | 'warmup'; github?: ToolContext['github'] } = {}) {
  const origin = options.metricsOrigin ?? 'visitor';
  const app = new OpenAPIHono<{ Variables: Vars }>({ defaultHook: (result, c) => {
    if (!result.success) return c.json({ error: 'Invalid request. Send one non-empty message under 8000 characters with a valid session.' }, 400);
  } });
  // ponytail: concurrency is per process; size the replica count against the provider's capacity.
  let active = 0;
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
  // Every header the browser client sends must be listed, or the preflight kills the request.
  app.use('*', cors({ origin: config.SITE_ORIGIN, allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: CLIENT_HEADERS, exposeHeaders: ['Retry-After'] }));
  app.use('/v1/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    if (c.req.method === 'OPTIONS') return next();
    if (c.req.header('origin') !== config.SITE_ORIGIN) return c.json({ error: 'Origin is not allowed' }, 403);
    const limit = await db.consumeRateLimit('requests', c.get('clientIP') || 'unknown', config.REQUESTS_PER_MINUTE, 60);
    if (!limit.allowed) {
      c.header('Retry-After', String(limit.retryAfter));
      return c.json({ error: 'Too many requests from this address. Please try again shortly.' }, 429);
    }
    await next();
  });
  // The token is the only proof of ownership: a guessed or expired one reads and writes nothing.
  const authenticate: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
    const sessionId = await sessionOf(c);
    if (!sessionId) return c.json({ error: 'Session is missing or expired. Start a new conversation.' }, 401);
    c.set('sessionId', sessionId);
    await next();
  };
  for (const path of ['/v1/chat', '/v1/transcribe', '/v1/actions/*', '/v1/artifacts/*', '/v1/bookings', '/v1/proposals']) app.use(path, authenticate);
  // Reject bad origins/tokens before buffering uploads. Only transcription needs a large body.
  app.use('/v1/*', (c, next) => bodyLimit({
    maxSize: c.req.path === '/v1/transcribe' ? Math.ceil(config.TRANSCRIPTION_MAX_BYTES * 4 / 3) + 200_000 : 200_000,
    onError: c => c.json({ error: 'Request is too large' }, 413),
  })(c, next));

  app.openapi(createRoute({ method: 'get', path: '/health', responses: { 200: { description: 'Process is running', content: { 'application/json': { schema: z.object({ status: z.literal('ok') }) } } } } }),
    c => c.json({ status: 'ok' as const }));

  app.openapi(createRoute({
    method: 'post', path: '/v1/sessions', summary: 'Start an anonymous conversation',
    description: 'Returns a bearer token identifying one anonymous conversation. Store it client-side and send it on every /v1 call. Expiry slides forward on each use; after that the session and what it owns are deleted. Conversations are not stored on the server.',
    responses: { 201: { description: 'Session created', content: { 'application/json': { schema: sessionSchema } } }, ...guardFailures, ...challengeFailures },
  }), async c => {
    const challenge = await checkChallenge(c, 'session');
    if (challenge) return challenge;
    return c.json(await db.createSession(), 201);
  });

  app.openapi(createRoute({
    method: 'post', path: '/v1/transcribe', summary: 'Transcribe a voice note',
    description: 'Requires the configured site Origin and a session bearer token. Takes one recorded clip as a base64 audio data URL, returns its transcript, and stores nothing: the browser keeps the audio and the text. The transcript is what the visitor then sends to /v1/chat.',
    request: { headers: authHeader, body: { required: true, content: { 'application/json': { schema: transcribeSchema } } } },
    responses: {
      200: { description: 'The transcript', content: { 'application/json': { schema: transcriptSchema } } },
      400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
      413: { description: 'Body too large', content: { 'application/json': { schema: errorSchema } } },
      502: { description: 'The transcription provider failed', content: { 'application/json': { schema: errorSchema } } },
      ...authFailure, ...guardFailures,
    },
  }), async c => {
    const { mediaType, dataUrl } = c.req.valid('json');
    // MediaRecorder reports the codec in the type; the container is what the provider wants.
    const container = mediaType.split(';')[0].trim().toLowerCase();
    const format = AUDIO_FORMATS[container];
    if (!format) return c.json({ error: 'That audio format is not supported.' }, 400);
    const audio = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    if (audio.length < 1000) return c.json({ error: 'That recording is empty.' }, 400);
    if (audio.length > config.TRANSCRIPTION_MAX_BYTES) return c.json({ error: 'That recording is too long to send.' }, 413);
    if (active >= config.MAX_CONCURRENT_REQUESTS) { c.header('Retry-After', '5'); return c.json({ error: 'Assistant is busy. Please try again shortly.' }, 429); }
    active++;
    const startedAt = Date.now();
    try {
      if (!await db.reserveDailyRequest(config.MAX_REQUESTS_PER_DAY)) return c.json({ error: 'The assistant’s daily request budget is spent. Please try tomorrow.' }, 429);
      const result = await client.audio.transcriptions.create({
        file: await toFile(audio, `voice.${format}`, { type: container }),
        model: config.OPENROUTER_TRANSCRIPTION_MODEL,
        temperature: 0,
      }, { signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(config.REQUEST_TIMEOUT_MS)]) });
      const text = typeof result === 'string' ? result : result.text;
      if (!text?.trim()) return c.json({ error: 'Nothing was heard in that recording.' }, 502);
      const usage = (result as { usage?: { seconds?: number; cost?: number } }).usage;
      void db.recordMetric({ kind: 'transcribe', outcome: 'complete', totalMs: Date.now() - startedAt, model: config.OPENROUTER_TRANSCRIPTION_MODEL, costUsd: usage?.cost, audioSeconds: usage?.seconds })
        .catch(metricError => console.error('Could not record metric:', metricError.message));
      return c.json({
        text: text.trim().slice(0, 8000),
        model: config.OPENROUTER_TRANSCRIPTION_MODEL,
        ...(typeof usage?.seconds === 'number' ? { seconds: usage.seconds } : {}),
        ...(typeof usage?.cost === 'number' ? { costUsd: usage.cost } : {}),
      }, 200);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      console.error('transcription failed', { ms: Date.now() - startedAt, timedOut });
      void db.recordMetric({ kind: 'transcribe', outcome: timedOut ? 'timeout' : 'error', totalMs: Date.now() - startedAt, model: config.OPENROUTER_TRANSCRIPTION_MODEL })
        .catch(metricError => console.error('Could not record metric:', metricError.message));
      return c.json({ error: timedOut ? 'Transcription took too long. Try a shorter clip.' : 'The recording could not be transcribed. Try again.' }, 502);
    } finally { active--; }
  });

  app.openapi(createRoute({
    method: 'post', path: '/v1/chat', summary: 'Stream a portfolio answer',
    description: 'Requires the configured site Origin and a session bearer token. The browser keeps the conversation and sends its recent turns as history; the server keeps the newest MAX_MESSAGES_PER_SESSION turns and trims the oldest to fit the context budget. When the full retained history, question, model, prompt, time zone and indexed commits match a finished answer from the last ANSWER_CACHE_TTL_HOURS, that answer is replayed across visitors with usage.cached set, without calling the model or spending the daily budget. Session-bound results are never cached. A voice note is transcribed first at /v1/transcribe and arrives here as text. POST using fetch; SSE data is one JSON ChatEvent per frame, and a done or error event terminates the response. OpenAPI describes each event, not the whole stream.',
    request: { headers: authHeader, body: { required: true, content: { 'application/json': { schema: chatSchema } } } },
    responses: {
      200: { description: 'SSE frames containing versioned ChatEvent JSON', content: { 'text/event-stream': { schema: eventSchema } } },
      400: { description: 'Invalid request', content: { 'application/json': { schema: errorSchema } } },
      413: { description: 'Body too large', content: { 'application/json': { schema: errorSchema } } },
      ...authFailure, ...guardFailures,
    },
  }), async c => {
    const { message, history: sent } = c.req.valid('json');
    const sessionId = c.get('sessionId');
    const history = sent.slice(-config.MAX_MESSAGES_PER_SESSION);
    while (history.length && history.reduce((sum, entry) => sum + entry.content.length, message.length) > MAX_CONTEXT_CHARS) history.splice(0, 2);
    const indexed = await retrieval.indexedRepos().catch(() => []);
    const systemPrompt = buildSystemPrompt(indexed, mailer.configured, storage.configured, scheduler.configured ? scheduler.eventTypes : []);
    c.header('Cache-Control', 'no-store, no-transform');
    c.header('X-Accel-Buffering', 'no');

    // Share identical full contexts, never just a suffix: answers may quote earlier private turns.
    // The visitor's time zone is not part of the key: it only shapes calendar answers, and those carry
    // session-bound events that are never cached. Leaving it in split every answer by time zone.
    const cacheKey = !config.ANSWER_CACHE_TTL_HOURS ? undefined : createHash('sha256').update(JSON.stringify({
      model: config.OPENROUTER_MODEL, system: systemPrompt,
      commits: indexed.map(entry => `${entry.repo}@${entry.commit}`),
      turns: [...history, { role: 'user', content: message }].map(({ role, content }) => [role, content]),
    })).digest();
    const cached = cacheKey && await db.cachedAnswer(cacheKey).catch(() => undefined);
    // A replay costs no model call, so it spends neither the daily budget nor a concurrency slot.
    if (cached) return streamSSE(c, async stream => {
      const startedAt = Date.now();
      let firstTokenMs: number | undefined;
      // A replay is instant, and an answer that lands whole reads as a page load, not a reply. So it
      // is paced like a fast stream: the text types out over REPLAY_MS scaled to its length, and each
      // tool step pauses briefly. The usage event still says cached, so nothing pretends to be live.
      const deltas = cached.filter(event => event.type === 'delta');
      const characters = deltas.reduce((sum, event) => sum + String(event.text ?? '').length, 0);
      const replayMs = Math.min(REPLAY_MAX_MS, Math.max(REPLAY_MIN_MS, characters * REPLAY_MS_PER_CHAR));
      const perDelta = deltas.length ? replayMs / deltas.length : 0;
      const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      for (const event of cached) {
        if (stream.aborted) return;
        if (firstTokenMs === undefined && event.type === 'delta') firstTokenMs = Date.now() - startedAt;
        await stream.writeSSE({ data: JSON.stringify({ version: 1, ...event }) });
        if (event.type === 'delta') await pause(perDelta);
        else if (event.type === 'tool' && event.status !== 'running') await pause(REPLAY_TOOL_PAUSE_MS);
      }
      const totalMs = Date.now() - startedAt;
      await stream.writeSSE({ data: JSON.stringify({ version: 1, type: 'usage', usage: { ms: totalMs, model: config.OPENROUTER_MODEL, cached: true } }) });
      await stream.writeSSE({ data: JSON.stringify({ version: 1, type: 'done', finishReason: 'stop' }) });
      const tools = [...new Set(cached.filter(event => event.type === 'tool' && event.status === 'done').map(event => String(event.name)))];
      void db.recordMetric({ kind: 'chat', cached: true, outcome: 'complete', totalMs, firstTokenMs, model: config.OPENROUTER_MODEL, costUsd: 0, tools, origin })
        .catch(error => console.error('Could not record metric:', error.message));
    });

    if (active >= config.MAX_CONCURRENT_REQUESTS) { c.header('Retry-After', '5'); return c.json({ error: 'Assistant is busy. Please try again shortly.' }, 429); }
    // Claim synchronously, before the budget query yields to another request.
    active++;
    try {
      if (!await db.reserveDailyRequest(config.MAX_REQUESTS_PER_DAY)) {
        active--;
        return c.json({ error: 'The assistant’s daily request budget is spent. Please try tomorrow.' }, 429);
      }
    } catch (error) { active--; throw error; }
    return streamSSE(c, async stream => {
      const controller = new AbortController();
      // Silence ends a turn, not length: every provider chunk and tool result pushes the deadline back,
      // so a long answer from a slow model finishes instead of being cut off at a fixed total.
      let idle = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
      const alive = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS); };
      const ceiling = setTimeout(() => controller.abort(), MAX_ANSWER_MS);
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
        { role: 'user' as const, content: message },
      ];
      const visitorTimeZone = timeZoneOf(c.req.header('x-time-zone'));
      const repoNames = indexed.map(entry => entry.repo);
      const toolDefinitions = buildToolDefinitions(repoNames, Boolean(options.github));
      const turnAvailability = new Map<string, Promise<Slot[]>>();
      const toolContext = {
        retrieval, repoNames, github: options.github, contactEnabled: mailer.configured, artifactsEnabled: storage.configured, maxArtifactBytes: config.ARTIFACT_MAX_BYTES,
        scheduling: scheduler.configured
          ? { timeZone: visitorTimeZone, eventTypes: scheduler.eventTypes, availability: (eventType: EventType) => {
            let pending = turnAvailability.get(eventType.key);
            if (!pending) {
              pending = availableSlots(eventType, visitorTimeZone).catch(error => { turnAvailability.delete(eventType.key); throw error; });
              turnAvailability.set(eventType.key, pending);
            }
            return pending;
          } }
          : undefined,
      };
      const sources: SourceHit[] = [];
      const readResults = new Map<string, ToolOutcome>();
      let answer = '';
      const startedAt = Date.now();
      const usage: { promptTokens?: number; completionTokens?: number; costUsd?: number; cachedPromptTokens?: number; reasoningTokens?: number } = {};
      const stepFirstMs: number[] = [];
      const stepMs: number[] = [];
      // What gets recorded about this answer once it ends, however it ends. No text, no session.
      let firstTokenMs: number | undefined;
      let steps = 0;
      let toolMs = 0;
      const toolsRun: string[] = [];
      let outcome: 'complete' | 'truncated' | 'error' | 'timeout' | 'aborted' = 'error';
      try {
        let finish: string | null = null;
        // Reserve one artifact-only step so research cannot consume the document's creation budget.
        const finalStep = config.MAX_TOOL_STEPS + (storage.configured && config.MAX_TOOL_STEPS > 0 ? 1 : 0);
        for (let step = 0; step <= finalStep; step++) {
          const stepTools = step < config.MAX_TOOL_STEPS ? toolDefinitions
            : step < finalStep ? toolDefinitions.filter(tool => tool.function.name === 'create_artifact') : [];
          const canUseTools = stepTools.length > 0;
          if (step === config.MAX_TOOL_STEPS && canUseTools) conversation.push({ role: 'system', content: 'Research is complete for this turn. Only create_artifact remains available. If the visitor requested a downloadable document and none was successfully created, create it now from the evidence already collected, noting any gaps. Do not request more research or repeat a successful artifact. Otherwise give your final answer.' });
          if (!canUseTools) conversation.push({ role: 'system', content: 'The tool budget is exhausted. No more tools can run in this turn. Answer using only results already received. Do not simulate tool calls in text or promise more work. If a requested document was not successfully created, say it is unavailable; otherwise point to its Download Markdown button.' });
          // Timed from the request, not from the first byte: connecting and queueing are part of the step.
          const stepStarted = Date.now();
          const response = await client.chat.completions.create({
            model: config.OPENROUTER_MODEL, messages: conversation, stream: true, max_tokens: config.MAX_OUTPUT_TOKENS,
            stream_options: { include_usage: true },
            ...(canUseTools ? { tools: stepTools, tool_choice: 'auto' as const } : {}),
            // OpenRouter's unified reasoning control; unset leaves the provider's default.
            ...(config.CHAT_REASONING_EFFORT ? { reasoning: { effort: config.CHAT_REASONING_EFFORT } } : {}),
          } as OpenAI.Chat.ChatCompletionCreateParamsStreaming, { signal: controller.signal });
          steps++;
          let stepFirst: number | undefined;

          const calls: { id: string; name: string; arguments: string }[] = [];
          let stepText = '';
          finish = null;
          for await (const chunk of response) {
            alive();
            stepFirst ??= Date.now() - stepStarted;
            if ('error' in chunk) throw new Error('Provider stream error');
            // Only what the provider actually reports: no estimates, no invented numbers.
            if (chunk.usage) {
              usage.promptTokens = (usage.promptTokens ?? 0) + (chunk.usage.prompt_tokens ?? 0);
              usage.completionTokens = (usage.completionTokens ?? 0) + (chunk.usage.completion_tokens ?? 0);
              const cost = (chunk.usage as { cost?: number }).cost;
              if (typeof cost === 'number') usage.costUsd = (usage.costUsd ?? 0) + cost;
              const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
              if (typeof cachedTokens === 'number') usage.cachedPromptTokens = (usage.cachedPromptTokens ?? 0) + cachedTokens;
              const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens;
              if (typeof reasoningTokens === 'number') usage.reasoningTokens = (usage.reasoningTokens ?? 0) + reasoningTokens;
            }
            const choice = chunk.choices[0];
            if (choice?.delta?.content) {
              firstTokenMs ??= Date.now() - startedAt;
              stepText += choice.delta.content;
              answer += choice.delta.content;
              await send({ type: 'delta', text: choice.delta.content });
            }
            // Ignore tool calls on the final step: no tools were offered, so any are spurious.
            for (const part of (canUseTools ? choice?.delta?.tool_calls : undefined) ?? []) {
              if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 12) throw new Error('Too many tool calls');
              const call = calls[part.index] ??= { id: '', name: '', arguments: '' };
              if (part.id) call.id = part.id;
              if (part.function?.name) call.name += part.function.name;
              if (part.function?.arguments) call.arguments += part.function.arguments;
              if (call.arguments.length > 1_000_000 || call.name.length > 80 || call.id.length > 200) throw new Error('Tool call too large');
            }
            if (choice?.finish_reason) finish = choice.finish_reason;
          }

          stepFirstMs.push(stepFirst ?? Date.now() - stepStarted);
          stepMs.push(Date.now() - stepStarted);
          const requested = calls.filter(call => call?.name);
          if (requested.some(call => !stepTools.some(tool => tool.function.name === call.name))) throw new Error('Tool unavailable in this step');
          if (!requested.length) break;
          conversation.push({ role: 'assistant', content: stepText || null, tool_calls: requested.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) });
          // Read-only lookups in one step run at once; their events and results still go out in call
          // order below. Anything with an effect (drafts, bookings, documents) stays sequential.
          const READ_ONLY = ['search_knowledge', 'read_source', 'list_files', 'portfolio_details', 'github_activity'];
          const early = new Map<string, Promise<ToolOutcome>>();
          for (const call of requested) {
            const key = `${call.name}:${call.arguments}`;
            if (READ_ONLY.includes(call.name) && !readResults.has(key) && !early.has(key)) early.set(key, runTool(toolContext, call.name, call.arguments));
          }
          for (const pending of early.values()) pending.catch(() => {});
          for (const call of requested) {
            controller.signal.throwIfAborted();
            const started = Date.now();
            await send({ type: 'tool', id: call.id, name: call.name, summary: 'running', status: 'running' });
            let outcome;
            try {
              const readOnly = READ_ONLY.includes(call.name);
              const key = `${call.name}:${call.arguments}`;
              outcome = readOnly ? readResults.get(key) : undefined;
              outcome ??= await (early.get(key) ?? runTool(toolContext, call.name, call.arguments));
              if (readOnly && !outcome.failed) readResults.set(key, outcome);
            }
            catch (error) {
              console.error('Tool failed:', call.name, error instanceof Error ? error.message : error);
              outcome = { summary: 'tool failed', result: 'The tool could not run. Say so instead of guessing.', sources: [], failed: true as const };
            }
            const ms = Date.now() - started;
            toolMs += ms;
            toolsRun.push(call.name);
            controller.signal.throwIfAborted();
            if (outcome.failed || outcome.live) recorded = undefined;
            await send({ type: 'tool', id: call.id, name: call.name, summary: outcome.summary, status: outcome.failed ? 'error' : 'done', ms });
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
              } catch (error) {
                recorded = undefined;
                console.error('Could not store artifact:', error instanceof Error ? error.message : error);
                await storage.remove([objectKey]).catch(() => console.error('Artifact upload cleanup failed'));
                conversation.push({ role: 'tool', tool_call_id: call.id, content: 'The document could not be stored. Tell the visitor it is unavailable and answer in the chat instead.' });
                continue;
              }
              const artifact = { id, kind, title, bytes, markdown: document, expiresAt: new Date(Date.now() + config.ARTIFACT_TTL_DAYS * 86400000).toISOString() };
              await send({ type: 'artifact', artifact });
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
            alive();
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
        outcome = finish === 'length' ? 'truncated' : 'complete';
      } catch {
        outcome = stream.aborted ? 'aborted' : controller.signal.aborted ? 'timeout' : 'error';
        if (!stream.aborted) await send({ type: 'error', message: controller.signal.aborted ? 'Response timed out. Please retry.' : 'The model could not finish this answer. Please retry.' });
      } finally {
        clearTimeout(idle); clearTimeout(ceiling); controller.abort(); active--;
        void db.recordMetric({
          kind: 'chat', outcome, totalMs: Date.now() - startedAt, firstTokenMs, model: config.OPENROUTER_MODEL, ...usage,
          steps, tools: toolsRun, toolMs, sources: sources.length, stepFirstMs, stepMs, origin,
        }).catch(error => console.error('Could not record metric:', error.message));
      }
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
      503: { description: 'Email delivery is not configured, or the bot check is unreachable', content: { 'application/json': { schema: errorSchema } } },
    },
  }), async c => {
    if (!mailer.configured) return c.json({ error: 'Email delivery is not configured on this server.' }, 503);
    const body = c.req.valid('json');
    // Silently accept the honeypot: a bot learns nothing from the response.
    if (body._gotcha) return c.json({ id: '', status: 'accepted' as const }, 202);
    // A draft belongs to a session that already passed the check when it started.
    if (!body.draftId) {
      const challenge = await checkChallenge(c, 'contact');
      if (challenge) return challenge;
    }

    const draft = { name: body.name, email: body.email, message: body.message };
    let draftId = body.draftId;
    if (draftId) {
      const sessionId = await sessionOf(c);
      if (!sessionId) return c.json({ error: 'Session is missing or expired. Start a new conversation.' }, 401);
      const claim = await db.claimDraft(draftId, sessionId, draft);
      if (!claim.claimed) {
        if (claim.status === 'sent') return c.json({ id: draftId, status: 'already-sent' as const }, 202);
        if (claim.status === 'sending' || claim.status === 'unknown') return c.json({ error: 'This message is being sent or delivery is unconfirmed. Please do not resend it.' }, 502);
        return c.json({ error: 'That draft is no longer available. Write the message again.' }, 404);
      }
    } else {
      draftId = await db.createDirectDraft(draft, config.CONTACT_DRAFT_TTL_MINUTES);
    }

    const limit = await db.consumeRateLimit('contact', c.get('clientIP') || 'unknown', config.CONTACT_SENDS_PER_HOUR, 3600);
    if (!limit.allowed || !await db.reserveContactSend(config.CONTACT_SENDS_PER_DAY)) {
      await db.finishDraft(draftId, 'failed');
      c.header('Retry-After', String(limit.allowed ? 86400 : limit.retryAfter));
      return c.json({ error: 'The message limit is reached. Please try later or email directly.' }, 429);
    }
    let providerId: string;
    try {
      providerId = await mailer.send({ name: draft.name, email: draft.email, body: draft.message });
    } catch (error) {
      if (error instanceof AmbiguousDeliveryError) {
        await db.finishDraft(draftId, 'unknown');
        return c.json({ error: 'Delivery was not confirmed. Please do not resend: the message may already have arrived.' }, 502);
      }
      // Keep the draft so the visitor can retry the same text, and free the reserved slot.
      console.error('Contact delivery failed:', error instanceof Error ? error.message : error);
      await db.finishDraft(draftId, 'failed').catch(() => {});
      await db.releaseContactSend().catch(() => {});
      return c.json({ error: 'The message could not be delivered. Your text is kept, please try again.' }, 502);
    }
    // A database failure after acceptance must not mark the message as safe to resend.
    await db.finishDraft(draftId, 'sent', providerId);
    return c.json({ id: draftId, status: 'accepted' as const }, 202);
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

  app.doc('/openapi.json', { openapi: '3.1.0', info: { title: 'Portfolio Assistant API', version: '0.2.0' } });
  app.get('/docs', apiReference({ url: '/openapi.json' }));
  app.onError((error, c) => {
    if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON' }, 400);
    console.error('Unhandled request error:', error.message);
    return c.json({ error: 'Request could not be processed' }, 500);
  });
  return app;
}
