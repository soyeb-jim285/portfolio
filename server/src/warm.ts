// Answers the site's own fixed questions ahead of time, so the answer cache already holds them when a
// visitor clicks a starter or an "Ask about" button: those replay in milliseconds instead of taking a
// multi-step model turn. Runs after each index pass, because a new index or prompt changes the keys.
import type { createApp } from './app';
import type { Db } from './db';

// Under the per-address limit (10 a minute), which these internal requests share.
const PACE_MS = 6500;

export async function warmAnswers(app: ReturnType<typeof createApp>, db: Db, origin: string, questions: string[], log: (message: string) => void) {
  const tally = { replayed: 0, answered: 0, failed: 0 };
  for (const [index, question] of questions.entries()) {
    if (index) await new Promise(resolve => setTimeout(resolve, PACE_MS));
    try {
      const { token } = await db.createSession();
      const response = await app.request('/v1/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: question }),
      });
      const body = await response.text();
      if (!response.ok || !body.includes('"type":"done"')) { tally.failed++; continue; }
      if (body.includes('"cached":true')) tally.replayed++; else tally.answered++;
    } catch { tally.failed++; }
  }
  log(`warm-up: ${questions.length} fixed questions, ${tally.answered} answered fresh, ${tally.replayed} already cached, ${tally.failed} failed`);
  return tally;
}
