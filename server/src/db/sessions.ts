import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

const hash = (token: string) => createHash('sha256').update(token).digest();

export function sessionQueries(pool: Pool, ttl: string) {
  return {
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
  };
}
