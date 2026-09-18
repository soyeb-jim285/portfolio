import assert from 'node:assert/strict';
import test from 'node:test';
import { AmbiguousDeliveryError, createMailer } from './mailer';

test('mail timeouts and server errors are ambiguous, explicit rejection is retryable', async () => {
  const config = { RESEND_API_KEY: 'test', CONTACT_FROM: 'site@example.com', CONTACT_TO: 'owner@example.com', CONTACT_LABEL: 'Owner' };
  const message = { name: 'Visitor', email: 'visitor@example.com', body: 'Hello there.' };
  for (const fetcher of [async () => { throw new Error('timeout'); }, async () => new Response('', { status: 503 })]) {
    await assert.rejects(createMailer(config, fetcher).send(message), AmbiguousDeliveryError);
  }
  await assert.rejects(createMailer(config, async () => new Response('', { status: 429 })).send(message), error => error instanceof Error && !(error instanceof AmbiguousDeliveryError));
});
