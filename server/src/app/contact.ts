import { createRoute, z } from '@hono/zod-openapi';
import { AmbiguousDeliveryError } from '../mailer';
import type { App, AppDeps } from './deps';
import { errorSchema } from './schemas';

export function registerContactRoute(app: App, { config, db, mailer, sessionOf, checkChallenge }: AppDeps) {
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
}
