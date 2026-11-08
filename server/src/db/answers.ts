import type { Pool } from 'pg';

export type AnswerMetric = {
  kind: 'chat' | 'transcribe'; cached?: boolean; outcome: 'complete' | 'truncated' | 'error' | 'timeout' | 'aborted';
  totalMs: number; firstTokenMs?: number; model: string; promptTokens?: number; completionTokens?: number; costUsd?: number;
  steps?: number; tools?: string[]; toolMs?: number; sources?: number; audioSeconds?: number;
  cachedPromptTokens?: number; reasoningTokens?: number; stepFirstMs?: number[]; stepMs?: number[]; origin?: 'visitor' | 'eval' | 'warmup';
};

export function answerQueries(pool: Pool) {
  return {
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
  };
}
