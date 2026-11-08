import type { Pool } from 'pg';

export function budgetQueries(pool: Pool) {
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
    // The daily budgets. Counting attempts rather than successes, so a retry storm cannot outspend them.
    // The column name comes from this closed list, never from a caller.
    reserveBooking: (max: number) => reserve('bookings', max),
    reserveContactSend: (max: number) => reserve('contact_sends', max),
    reserveDailyRequest: (max: number) => reserve('requests', max),
    releaseBooking: () => release('bookings'),
    releaseContactSend: () => release('contact_sends'),
  };
}
