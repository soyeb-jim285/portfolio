import { createRoute, z } from '@hono/zod-openapi';
import { toFile } from 'openai';
import type { App, AppDeps } from './deps';
import { authFailure, authHeader, errorSchema, guardFailures } from './schemas';

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

export function registerTranscribeRoute(app: App, { config, db, client, concurrency }: AppDeps) {
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
    if (concurrency.active >= config.MAX_CONCURRENT_REQUESTS) { c.header('Retry-After', '5'); return c.json({ error: 'Assistant is busy. Please try again shortly.' }, 429); }
    concurrency.active++;
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
    } finally { concurrency.active--; }
  });
}
