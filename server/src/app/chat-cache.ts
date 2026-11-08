import { createHash } from 'node:crypto';
import type { SSEStreamingApi } from 'hono/streaming';
import type { Config } from '../config';
import type { AppDeps, AppOptions } from './deps';

// Cache replays are paced like a fast stream (see the replay branch of /v1/chat).
const REPLAY_MIN_MS = 350;
const REPLAY_MAX_MS = 1200;
const REPLAY_MS_PER_CHAR = 0.8;
const REPLAY_TOOL_PAUSE_MS = 120;

export function answerCacheKey(config: Config, options: AppOptions, systemPrompt: string, indexed: { repo: string; commit: string }[], history: { role: string; content: string }[], message: string) {
  // Share identical full contexts, never just a suffix: answers may quote earlier private turns.
  // The visitor's time zone is not part of the key: it only shapes calendar answers, and those carry
  // session-bound events that are never cached. Leaving it in split every answer by time zone.
  return !config.ANSWER_CACHE_TTL_HOURS ? undefined : createHash('sha256').update(JSON.stringify({
    model: config.OPENROUTER_MODEL, genUi: options.genUi ? config.JEV_MODEL : '', system: systemPrompt,
    commits: indexed.map(entry => `${entry.repo}@${entry.commit}`),
    turns: [...history, { role: 'user', content: message }].map(({ role, content }) => [role, content]),
  })).digest();
}

export async function replayAnswer({ config, db, origin }: AppDeps, stream: SSEStreamingApi, cached: Record<string, unknown>[]) {
  const startedAt = Date.now();
  let firstTokenMs: number | undefined;
  // A replay is instant, and an answer that lands whole reads as a page load, not a reply. So it
  // is paced like a fast stream: the text types out over REPLAY_MS scaled to its length, and each
  // tool step pauses briefly. The usage event still says cached, so nothing pretends to be live.
  const deltas = cached.filter(event => event.type === 'delta');
  const characters = deltas.reduce((sum, event) => sum + String(event.text ?? '').length, 0);
  const replayMs = Math.min(REPLAY_MAX_MS, Math.max(REPLAY_MIN_MS, characters * REPLAY_MS_PER_CHAR));
  const perDelta = deltas.length ? replayMs / deltas.length : 0;
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  for (const event of cached) {
    if (stream.aborted) return;
    if (firstTokenMs === undefined && event.type === 'delta') firstTokenMs = Date.now() - startedAt;
    await stream.writeSSE({ data: JSON.stringify({ version: 1, ...event }) });
    if (event.type === 'delta') await pause(perDelta);
    else if (event.type === 'tool' && event.status !== 'running') await pause(REPLAY_TOOL_PAUSE_MS);
  }
  const totalMs = Date.now() - startedAt;
  await stream.writeSSE({ data: JSON.stringify({ version: 1, type: 'usage', usage: { ms: totalMs, model: config.OPENROUTER_MODEL, cached: true } }) });
  await stream.writeSSE({ data: JSON.stringify({ version: 1, type: 'done', finishReason: 'stop' }) });
  const tools = [...new Set(cached.filter(event => event.type === 'tool' && event.status === 'done').map(event => String(event.name)))];
  void db.recordMetric({ kind: 'chat', cached: true, outcome: 'complete', totalMs, firstTokenMs, model: config.OPENROUTER_MODEL, costUsd: 0, tools, origin })
    .catch(error => console.error('Could not record metric:', error.message));
}
