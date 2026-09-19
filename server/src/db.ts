import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const schemaPath = new URL('./schema.sql', import.meta.url);
const hash = (token: string) => createHash('sha256').update(token).digest();

// Every entry point applies the schema, so the API and the indexer can start in either order.
// A serverless database may be suspended, and the first connection pays its cold start, so retry once.
export async function applySchema(pool: Pool) {
  const schema = await readFile(schemaPath, 'utf8');
  // A migration may rewrite a table (adding a stored generated column does), which can outlast the
  // pool's statement timeout, so it runs on its own connection with the timeout lifted and restored.
  const run = async () => {
    const client = await pool.connect();
    try {
      await client.query('SET statement_timeout = 0');
      await client.query(schema);
    } finally {
      await client.query('RESET statement_timeout').catch(() => {});
      client.release();
    }
  };
  try { await run(); }
  catch (error) {
    console.error('First database connection failed, retrying:', error instanceof Error ? error.message : error);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await run();
  }
}

export type AnswerMetric = {
  kind: 'chat' | 'transcribe'; cached?: boolean; outcome: 'complete' | 'truncated' | 'error' | 'timeout' | 'aborted';
  totalMs: number; firstTokenMs?: number; model: string; promptTokens?: number; completionTokens?: number; costUsd?: number;
  steps?: number; tools?: string[]; toolMs?: number; sources?: number; audioSeconds?: number;
  cachedPromptTokens?: number; reasoningTokens?: number; stepFirstMs?: number[]; stepMs?: number[]; origin?: 'visitor' | 'eval' | 'warmup';
};

export type Db = Awaited<ReturnType<typeof createDb>>;

export async function createDb(url: string, ttlDays: number, metricsDays = 90) {
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 20000, statement_timeout: 15000, idle_in_transaction_session_timeout: 15000 });
  pool.on('error', error => console.error('Database pool error:', error.message));
  await applySchema(pool);
  const ttl = `${ttlDays} days`;

  type Budget = 'bookings' | 'contact_sends' | 'requests';
  const reserve = async (column: Budget, max: number) => {
    const { rowCount } = await pool.query(
      `INSERT INTO usage_daily (day, ${column}) VALUES (CURRENT_DATE, 1)
       ON CONFLICT (day) DO UPDATE SET ${column} = usage_daily.${column} + 1
       WHERE usage_daily.${column} < $1 RETURNING ${column}`, [max]);
    return rowCount === 1;
  };
  const release = async (column: Budget) => {
    await pool.query(`UPDATE usage_daily SET ${column} = greatest(${column} - 1, 0) WHERE day = CURRENT_DATE`);
  };

  return {
    // Exposed so retrieval can share the same pool.
    pool,
    // One host calendar: serialize the live-check/create pair across API replicas.
    async acquireBookingLock() {
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN; SET LOCAL idle_in_transaction_session_timeout = '120s'");
        const { rows } = await connection.query('SELECT pg_try_advisory_xact_lock(72741852) AS acquired');
        if (!rows[0].acquired) { await connection.query('ROLLBACK'); connection.release(); return null; }
        return async () => {
          try { await connection.query('ROLLBACK'); connection.release(); }
          catch (error) { connection.release(true); throw error; }
        };
      } catch (error) { connection.release(true); throw error; }
    },
    async consumeRateLimit(scope: string, address: string, max: number, seconds: number) {
      const { rows } = await pool.query<{ count: number; retry: number }>(
        `INSERT INTO rate_limits (key, count, expires_at) VALUES ($1, 1, now() + make_interval(secs => $3))
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN rate_limits.expires_at <= now() THEN 1 ELSE least(rate_limits.count + 1, $2 + 1) END,
           expires_at = CASE WHEN rate_limits.expires_at <= now() THEN now() + make_interval(secs => $3) ELSE rate_limits.expires_at END
         RETURNING count, greatest(1, ceil(extract(epoch FROM expires_at - now())))::integer AS retry`,
        [hash(`${scope}:${address}`), max, seconds]);
      return { allowed: rows[0].count <= max, retryAfter: rows[0].retry };
    },
    async createSession() {
      const token = randomBytes(32).toString('base64url');
      const { rows } = await pool.query<{ expires_at: Date }>(
        `INSERT INTO sessions (token_hash, expires_at) VALUES ($1, now() + $2::interval) RETURNING expires_at`, [hash(token), ttl]);
      return { token, expiresAt: rows[0].expires_at.toISOString() };
    },
    // Sliding expiry: an unused session is deleted by the sweep, an active one keeps living.
    async touchSession(token: string) {
      const { rows } = await pool.query<{ id: string }>(
        `UPDATE sessions SET last_seen_at = now(), expires_at = now() + $2::interval
         WHERE token_hash = $1 AND expires_at > now() RETURNING id`, [hash(token), ttl]);
      return rows[0]?.id;
    },
    async cachedAnswer(key: Buffer) {
      const { rows } = await pool.query<{ events: Record<string, unknown>[] }>(
        `UPDATE answer_cache SET hits = hits + 1 WHERE key = $1 AND expires_at > now() RETURNING events`, [key]);
      return rows[0]?.events;
    },
    async cacheAnswer(key: Buffer, events: Record<string, unknown>[], ttlHours: number) {
      await pool.query(
        `INSERT INTO answer_cache (key, events, expires_at) VALUES ($1, $2::jsonb, now() + make_interval(secs => $3))
         ON CONFLICT (key) DO UPDATE SET events = EXCLUDED.events, created_at = now(), expires_at = EXCLUDED.expires_at, hits = 0`,
        [key, JSON.stringify(events), ttlHours * 3600]);
    },
    // Recorded when requested and updated only by the session that owns it.
    async recordAction(id: string, sessionId: string, target: string) {
      await pool.query('INSERT INTO ui_actions (id, session_id, target) VALUES ($1, $2, $3)', [id, sessionId, target]);
    },
    async acknowledgeAction(id: string, sessionId: string, status: 'done' | 'missing' | 'failed') {
      const { rowCount } = await pool.query(
        `UPDATE ui_actions SET status = $3, acknowledged_at = now() WHERE id = $1 AND session_id = $2 AND status = 'requested'`,
        [id, sessionId, status]);
      return rowCount === 1;
    },
    async createDraft(sessionId: string, draft: { name: string; email: string; message: string }, ttlMinutes: number) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO contact_drafts (id, session_id, name, email, message, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
        [id, sessionId, draft.name, draft.email, draft.message, ttlMinutes]);
      return id;
    },
    // Atomic claim: concurrent sends of one draft cannot both reach the provider.
    async claimDraft(id: string, sessionId: string, final: { name: string; email: string; message: string }) {
      const { rows } = await pool.query(
        `UPDATE contact_drafts SET status = 'sending', name = $3, email = $4, message = $5
         WHERE id = $1 AND session_id = $2 AND status IN ('draft', 'failed') AND expires_at > now()
         RETURNING id`, [id, sessionId, final.name, final.email, final.message]);
      if (rows[0]) return { claimed: true as const };
      const existing = await pool.query<{ status: string; provider_id: string | null }>(
        'SELECT status, provider_id FROM contact_drafts WHERE id = $1 AND session_id = $2', [id, sessionId]);
      return { claimed: false as const, status: existing.rows[0]?.status, providerId: existing.rows[0]?.provider_id };
    },
    async createDirectDraft(draft: { name: string; email: string; message: string }, ttlMinutes: number) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO contact_drafts (id, session_id, name, email, message, status, expires_at)
         VALUES ($1, NULL, $2, $3, $4, 'sending', now() + make_interval(mins => $5))`,
        [id, draft.name, draft.email, draft.message, ttlMinutes]);
      return id;
    },
    async finishDraft(id: string, status: 'sent' | 'failed' | 'unknown', providerId = '') {
      await pool.query(
        `UPDATE contact_drafts SET status = $2, provider_id = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END WHERE id = $1`,
        [id, status, providerId || null]);
    },
    async createArtifact(artifact: { id: string; sessionId: string; kind: string; title: string; objectKey: string; bytes: number; sources: unknown }, ttlDays: number) {
      await pool.query(
        `INSERT INTO artifacts (id, session_id, kind, title, object_key, bytes, sources, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now() + make_interval(days => $8))`,
        [artifact.id, artifact.sessionId, artifact.kind, artifact.title, artifact.objectKey, artifact.bytes, JSON.stringify(artifact.sources), ttlDays]);
    },
    // The row is the permission check: no row for this session means no signed URL.
    async findArtifact(id: string, sessionId: string) {
      const { rows } = await pool.query<{ object_key: string; title: string; kind: string; expires_at: Date }>(
        'SELECT object_key, title, kind, expires_at FROM artifacts WHERE id = $1 AND session_id = $2 AND expires_at > now()', [id, sessionId]);
      return rows[0];
    },
    async expiredArtifacts(limit = 200) {
      const { rows } = await pool.query<{ id: string; object_key: string }>(
        `SELECT a.id, a.object_key FROM artifacts a JOIN sessions s ON s.id = a.session_id
         WHERE a.expires_at <= now() OR s.expires_at <= now() LIMIT $1`, [limit]);
      return rows.map(row => ({ id: row.id, objectKey: row.object_key }));
    },
    async deleteArtifacts(ids: string[]) {
      if (ids.length) await pool.query('DELETE FROM artifacts WHERE id = ANY($1::uuid[])', [ids]);
    },
    async createBooking(booking: { sessionId: string; meetingKey: string; slotStart: string; name: string; email: string; timeZone: string; notes: string }, ttlMinutes: number) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO bookings (id, session_id, meeting_key, slot_start, name, email, time_zone, notes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(mins => $9))`,
        [id, booking.sessionId, booking.meetingKey, booking.slotStart, booking.name, booking.email, booking.timeZone, booking.notes, ttlMinutes]);
      return id;
    },
    // Atomic claim, so two confirmations of one proposal cannot both reach the provider.
    // An 'unknown' outcome is deliberately not re-claimable: a maybe-created booking is never retried.
    async claimBooking(id: string, sessionId: string, final: { slotStart: string; name: string; email: string; timeZone: string }) {
      const { rows } = await pool.query(
        `UPDATE bookings SET status = 'confirming', slot_start = $3, name = $4, email = $5, time_zone = $6
         WHERE id = $1 AND session_id = $2 AND status IN ('pending', 'conflict', 'failed') AND expires_at > now()
         RETURNING id, meeting_key`, [id, sessionId, final.slotStart, final.name, final.email, final.timeZone]);
      if (rows[0]) return { claimed: true as const, meetingKey: rows[0].meeting_key };
      const existing = await pool.query<{ status: string; provider_uid: string | null; slot_start: Date; meeting_key: string }>(
        'SELECT status, provider_uid, slot_start, meeting_key FROM bookings WHERE id = $1 AND session_id = $2', [id, sessionId]);
      return { claimed: false as const, meetingKey: existing.rows[0]?.meeting_key, status: existing.rows[0]?.status, providerUid: existing.rows[0]?.provider_uid, slotStart: existing.rows[0]?.slot_start };
    },
    async finishBooking(id: string, status: 'confirmed' | 'conflict' | 'failed' | 'unknown', providerUid = '') {
      await pool.query(
        `UPDATE bookings SET status = $2, provider_uid = $3, confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() ELSE confirmed_at END WHERE id = $1`,
        [id, status, providerUid || null]);
    },
    // The daily budgets. Counting attempts rather than successes, so a retry storm cannot outspend them.
    // The column name comes from this closed list, never from a caller.
    reserveBooking: (max: number) => reserve('bookings', max),
    reserveContactSend: (max: number) => reserve('contact_sends', max),
    reserveDailyRequest: (max: number) => reserve('requests', max),
    releaseBooking: () => release('bookings'),
    releaseContactSend: () => release('contact_sends'),
    // Best effort by design: a metrics insert must never fail or slow the answer it describes.
    async recordMetric(metric: AnswerMetric) {
      await pool.query(
        `INSERT INTO answer_metrics (kind, cached, outcome, total_ms, first_token_ms, model, prompt_tokens, completion_tokens, cost_usd, steps, tools, tool_ms, sources, audio_seconds,
                                     cached_prompt_tokens, reasoning_tokens, step_first_ms, step_ms, origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [metric.kind, metric.cached ?? false, metric.outcome, Math.round(metric.totalMs), metric.firstTokenMs == null ? null : Math.round(metric.firstTokenMs),
          metric.model, metric.promptTokens ?? null, metric.completionTokens ?? null, metric.costUsd ?? null, metric.steps ?? 0,
          metric.tools ?? [], Math.round(metric.toolMs ?? 0), metric.sources ?? 0, metric.audioSeconds ?? null,
          metric.cachedPromptTokens ?? null, metric.reasoningTokens ?? null, (metric.stepFirstMs ?? []).map(Math.round), (metric.stepMs ?? []).map(Math.round), metric.origin ?? 'visitor']);
    },
    async sweep() {
      await pool.query(`DELETE FROM contact_drafts WHERE expires_at <= now()`);
      await pool.query(`DELETE FROM bookings WHERE expires_at <= now()`);
      // Keep ownership rows until the object-storage sweep has removed their documents.
      const { rowCount } = await pool.query(`DELETE FROM sessions s WHERE expires_at <= now() AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.session_id = s.id)`);
      await pool.query(`DELETE FROM usage_daily WHERE day < CURRENT_DATE - 30`);
      await pool.query(`DELETE FROM answer_cache WHERE expires_at <= now()`);
      await pool.query(`DELETE FROM rate_limits WHERE expires_at <= now()`);
      await pool.query(`DELETE FROM answer_metrics WHERE created_at < now() - make_interval(days => $1)`, [metricsDays]);
      return rowCount ?? 0;
    },
    close: () => pool.end(),
  };
}
