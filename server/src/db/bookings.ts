import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export function bookingQueries(pool: Pool) {
  return {
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
  };
}
