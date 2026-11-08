import { createRoute } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { buildSystemPrompt } from '../knowledge';
import { answerCacheKey, replayAnswer } from './chat-cache';
import { streamTurn } from './chat-turn';
import type { App, AppDeps } from './deps';
import { MAX_CONTEXT_CHARS, authFailure, authHeader, chatSchema, errorSchema, eventSchema, guardFailures } from './schemas';

export function registerChatRoute(app: App, deps: AppDeps) {
  const { config, db, retrieval, mailer, storage, scheduler, options, concurrency } = deps;
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

    const cacheKey = answerCacheKey(config, options, systemPrompt, indexed, history, message);
    const cached = cacheKey && await db.cachedAnswer(cacheKey).catch(() => undefined);
    // A replay costs no model call, so it spends neither the daily budget nor a concurrency slot.
    if (cached) return streamSSE(c, stream => replayAnswer(deps, stream, cached));

    if (concurrency.active >= config.MAX_CONCURRENT_REQUESTS) { c.header('Retry-After', '5'); return c.json({ error: 'Assistant is busy. Please try again shortly.' }, 429); }
    // Claim synchronously, before the budget query yields to another request.
    concurrency.active++;
    try {
      if (!await db.reserveDailyRequest(config.MAX_REQUESTS_PER_DAY)) {
        concurrency.active--;
        return c.json({ error: 'The assistant’s daily request budget is spent. Please try tomorrow.' }, 429);
      }
    } catch (error) { concurrency.active--; throw error; }
    return streamSSE(c, stream => streamTurn(deps, c, stream, { message, history, systemPrompt, indexed, cacheKey, sessionId }));
  });
}
