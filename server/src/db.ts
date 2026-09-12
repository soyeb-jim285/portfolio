import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const schemaPath = new URL('./schema.sql', import.meta.url);
const hash = (token: string) => createHash('sha256').update(token).digest();

// Every entry point applies the schema, so the API and the indexer can start in either order.
// A serverless database may be suspended, and the first connection pays its cold start, so retry once.
export async function applySchema(pool: Pool) {
  const schema = await readFile(schemaPath, 'utf8');
  try { await pool.query(schema); }
  catch (error) {
    console.error('First database connection failed, retrying:', error instanceof Error ? error.message : error);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await pool.query(schema);
  }
}

export type Db = Awaited<ReturnType<typeof createDb>>;

export async function createDb(url: string, ttlDays: number) {
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 20000 });
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
        `UPDATE contact_drafts SET name = $3, email = $4, message = $5
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
        `INSERT INTO contact_drafts (id, session_id, name, email, message, expires_at)
         VALUES ($1, NULL, $2, $3, $4, now() + make_interval(mins => $5))`,
        [id, draft.name, draft.email, draft.message, ttlMinutes]);
      return id;
    },
    async finishDraft(id: string, status: 'sent' | 'failed', providerId = '') {
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
        'SELECT id, object_key FROM artifacts WHERE expires_at <= now() LIMIT $1', [limit]);
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
        `UPDATE bookings SET slot_start = $3, name = $4, email = $5, time_zone = $6
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
    async sweep() {
      await pool.query(`DELETE FROM contact_drafts WHERE status = 'draft' AND expires_at <= now()`);
      await pool.query(`DELETE FROM bookings WHERE status = 'pending' AND expires_at <= now()`);
      const { rowCount } = await pool.query(`DELETE FROM sessions WHERE expires_at <= now()`);
      await pool.query(`DELETE FROM usage_daily WHERE day < CURRENT_DATE - 30`);
      return rowCount ?? 0;
    },
    close: () => pool.end(),
  };
}
