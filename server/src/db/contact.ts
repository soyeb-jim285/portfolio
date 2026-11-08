import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export function contactQueries(pool: Pool) {
  return {
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
  };
}
