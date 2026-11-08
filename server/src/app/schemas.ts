import { z } from '@hono/zod-openapi';

export const MAX_CONTEXT_CHARS = 24000;
// The browser owns the conversation and sends its recent turns with each question. It is the
// visitor's own transcript, so a forged turn only steers that visitor's answer; every tool that
// reaches the outside world still waits for the visitor's click.
const historySchema = z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(MAX_CONTEXT_CHARS) }).strict()).max(200);
export const chatSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  history: historySchema.default([]),
}).strict();
export const errorSchema = z.object({ error: z.string() });
export const sessionSchema = z.object({ token: z.string(), expiresAt: z.string() });
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
export const slotSchema = z.object({ start: z.string(), end: z.string() }).openapi('Slot');
const slotsSchema = z.object({ timeZone: z.string(), durationMinutes: z.number(), label: z.string(), key: z.string(), slots: z.array(slotSchema) }).openapi('Availability');
export const proposalSchema = z.object({
  id: z.string(), start: z.string(), end: z.string(), timeZone: z.string(), durationMinutes: z.number(), label: z.string(), key: z.string(),
  name: z.string(), email: z.string(), notes: z.string(),
}).openapi('BookingProposal');
const usageSchema = z.object({
  ms: z.number(), model: z.string(), promptTokens: z.number().optional(), completionTokens: z.number().optional(), costUsd: z.number().optional(),
  cached: z.boolean().optional().openapi({ description: 'True when a stored answer was replayed instead of generated.' }),
}).openapi('Usage');
const generatedUiSchema = z.object({
  model: z.string(),
  spec: z.object({
    root: z.string(),
    elements: z.record(z.string(), z.object({
      type: z.string(), props: z.record(z.string(), z.unknown()), children: z.array(z.string()).optional(), slots: z.record(z.string(), z.array(z.string())).optional(),
    }).passthrough()),
    state: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
}).openapi('GeneratedUi');
export const eventSchema = z.discriminatedUnion('type', [
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
  z.object({ version: z.literal(1), type: z.literal('ui'), ui: generatedUiSchema })
    .openapi({ description: 'A Jev-composed, catalog-constrained JSON Render spec. Component types and props come from server-owned candidates.' }),
  z.object({ version: z.literal(1), type: z.literal('usage'), usage: usageSchema })
    .openapi({ description: 'Measured answer latency and the provider-reported token usage, when the provider reports it.' }),
  z.object({ version: z.literal(1), type: z.literal('done'), finishReason: z.enum(['stop', 'length']) }),
  z.object({ version: z.literal(1), type: z.literal('error'), message: z.string() }),
]).openapi('ChatEvent');
export const authHeader = z.object({ authorization: z.string().openapi({ description: 'Bearer <session token>', example: 'Bearer abc123' }) });
export const authFailure = { 401: { description: 'Missing, unknown or expired session', content: { 'application/json': { schema: errorSchema } } } };
// A 403 here is a failed check; the 503 is Cloudflare being unreachable, which fails closed.
export const challengeFailures = {
  503: { description: 'The bot check could not be reached', content: { 'application/json': { schema: errorSchema } } },
};
export const guardFailures = {
  403: { description: 'Disallowed origin', content: { 'application/json': { schema: errorSchema } } },
  429: { description: 'Rate, concurrency or daily budget limit', content: { 'application/json': { schema: errorSchema } } },
};
