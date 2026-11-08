import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import OpenAI from 'openai';
import type { Config } from './config';
import type { Db } from './db';
import type { Retrieval } from './retrieval';
import type { Mailer } from './mailer';
import type { Storage } from './storage';
import type { Scheduler } from './scheduler';
import { registerBookingRoutes } from './app/bookings';
import { registerChatRoute } from './app/chat';
import { registerContactRoute } from './app/contact';
import { createDeps, type AppOptions, type Vars } from './app/deps';
import { authFailure, authHeader, challengeFailures, errorSchema, guardFailures, sessionSchema } from './app/schemas';
import { registerTranscribeRoute } from './app/transcribe';

export const CLIENT_HEADERS = ['Content-Type', 'Authorization', 'X-Time-Zone', 'X-Turnstile-Token'];

// metricsOrigin labels every metric this app instance records: the public app says 'visitor', while the
// eval and the cache warm-up build their own instances, so no request header can relabel traffic.
export function createApp(config: Config, db: Db, retrieval: Retrieval, mailer: Mailer, storage: Storage, scheduler: Scheduler, client = new OpenAI({ apiKey: config.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 0 }),
  options: AppOptions = {}) {
  const app = new OpenAPIHono<{ Variables: Vars }>({ defaultHook: (result, c) => {
    if (!result.success) return c.json({ error: 'Invalid request. Send one non-empty message under 8000 characters with a valid session.' }, 400);
  } });
  const deps = createDeps(config, db, retrieval, mailer, storage, scheduler, client, options);
  const { sessionOf, checkChallenge } = deps;
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

  registerTranscribeRoute(app, deps);

  registerChatRoute(app, deps);

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

  registerContactRoute(app, deps);

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

  registerBookingRoutes(app, deps);

  app.doc('/openapi.json', { openapi: '3.1.0', info: { title: 'Portfolio Assistant API', version: '0.2.0' } });
  app.onError((error, c) => {
    if (error instanceof SyntaxError) return c.json({ error: 'Invalid JSON' }, 400);
    console.error('Unhandled request error:', error.message);
    return c.json({ error: 'Request could not be processed' }, 500);
  });
  return app;
}
