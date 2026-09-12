import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import { configSchema } from './config';
import { createApp } from './app';
import { createDb } from './db';
import { createEmbedder } from './embeddings';
import { createMailer } from './mailer';
import { createStorage } from './storage';
import { createGoogleScheduler } from './google-calendar';
import { createCalScheduler } from './cal-calendar';
import { createRetrieval } from './retrieval';

const config = configSchema.parse(process.env);
const db = await createDb(config.DATABASE_URL, config.SESSION_TTL_DAYS, config.MAX_MESSAGES_PER_SESSION);

const retrieval = createRetrieval(db.pool, createEmbedder(config.OPENROUTER_API_KEY, config.OPENROUTER_EMBEDDING_MODEL, config.OPENROUTER_EMBEDDING_DIMS));
const indexed = await retrieval.indexedRepos().catch(error => { console.error('Could not read the code index:', error.message); return []; });
console.log(indexed.length ? `Code index: ${indexed.map(entry => `${entry.repo}@${entry.commit.slice(0, 8)}`).join(', ')}` : 'Code index: empty, run `npm run index`');

const mailer = createMailer(config);
console.log(mailer.configured ? `Contact delivery: on, to ${config.CONTACT_TO}` : 'Contact delivery: off, set RESEND_API_KEY, CONTACT_FROM and CONTACT_TO');

const storage = createStorage(config);
console.log(storage.configured ? `Artifacts: on, bucket ${config.R2_BUCKET}` : 'Artifacts: off, set the R2_* variables');

const scheduler = config.SCHEDULER === 'google'
  ? createGoogleScheduler({ ...config, MEETING_HOURS: { days: config.MEETING_DAYS, start: config.MEETING_START, end: config.MEETING_END } })
  : createCalScheduler(config);
console.log(scheduler.configured
  ? `Scheduling: on via ${config.SCHEDULER}, ${scheduler.eventTypes.map(type => `${type.label} (${type.minutes}min)`).join(', ')}`
  : `Scheduling: off, set ${config.SCHEDULER === 'google' ? 'the GOOGLE_* variables' : 'CAL_API_KEY and CAL_EVENT_TYPES'}`);

// Expired rows and their objects go together: a stored document must never outlive its row.
async function sweepAll() {
  const expired = await db.expiredArtifacts();
  if (expired.length && storage.configured) await storage.remove(expired.map(artifact => artifact.objectKey));
  await db.deleteArtifacts(expired.map(artifact => artifact.id));
  await db.sweep();
}
// An hourly in-process sweep is enough for one node. Move it to cron if you run several.
const sweep = setInterval(() => { void sweepAll().catch(error => console.error('Sweep failed:', error.message)); }, 3600000);
sweep.unref();
await sweepAll();

const app = new Hono<{ Variables: { clientIP: string; sessionId: string } }>();
// Use the socket peer, never an untrusted forwarded header.
app.use('*', async (c, next) => { c.set('clientIP', getConnInfo(c).remote.address || 'unknown'); await next(); });
app.route('/', createApp(config, db, retrieval, mailer, storage, scheduler));
const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT });
console.log(`Portfolio API: http://${config.HOST}:${config.PORT}/docs`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  clearInterval(sweep);
  server.close(() => { void db.close().finally(() => process.exit(0)); });
  setTimeout(() => process.exit(1), config.REQUEST_TIMEOUT_MS + 1000).unref();
});
