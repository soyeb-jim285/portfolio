import type { Context } from 'hono';
import type { SSEStreamingApi } from 'hono/streaming';
import type OpenAI from 'openai';
import type { SourceHit } from '../retrieval';
import type { EventType, Slot } from '../scheduler';
import { buildToolDefinitions, type ToolOutcome } from '../tools';
import { readStep, type TurnState } from './chat-step';
import { runToolCalls } from './chat-tools';
import type { AppDeps } from './deps';

// However lively the stream, one answer never runs longer than this.
const MAX_ANSWER_MS = 300000;
// These events carry ids owned by the session that asked, or depend on the clock: never replayed to another.
const SESSION_BOUND_EVENTS = new Set(['draft', 'proposal', 'artifact', 'action', 'slots']);

type TurnInput = {
  message: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  systemPrompt: string;
  indexed: { repo: string; commit: string }[];
  cacheKey: Buffer | undefined;
  sessionId: string;
};

export async function streamTurn(deps: AppDeps, c: Context, stream: SSEStreamingApi, { message, history, systemPrompt, indexed, cacheKey, sessionId }: TurnInput) {
  const { config, db, retrieval, mailer, storage, scheduler, client, options, origin, concurrency, timeZoneOf, availableSlots } = deps;
  const controller = new AbortController();
  // Silence ends a turn, not length: every provider chunk and tool result pushes the deadline back,
  // so a long answer from a slow model finishes instead of being cut off at a fixed total.
  let idle = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
  const alive = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS); };
  const ceiling = setTimeout(() => controller.abort(), MAX_ANSWER_MS);
  stream.onAbort(() => controller.abort());
  const send = (event: Record<string, unknown>) => {
    if (turn.recorded && SESSION_BOUND_EVENTS.has(String(event.type))) turn.recorded = undefined;
    turn.recorded?.push(event);
    return stream.writeSSE({ data: JSON.stringify({ version: 1, ...event }) });
  };
  const conversation: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history.map(entry => ({ role: entry.role, content: entry.content })),
    { role: 'user' as const, content: message },
  ];
  const visitorTimeZone = timeZoneOf(c.req.header('x-time-zone'));
  const repoNames = indexed.map(entry => entry.repo);
  const toolDefinitions = buildToolDefinitions(repoNames, Boolean(options.github));
  const turnAvailability = new Map<string, Promise<Slot[]>>();
  const toolContext = {
    retrieval, repoNames, github: options.github, contactEnabled: mailer.configured, artifactsEnabled: storage.configured, maxArtifactBytes: config.ARTIFACT_MAX_BYTES,
    scheduling: scheduler.configured
      ? { timeZone: visitorTimeZone, eventTypes: scheduler.eventTypes, availability: (eventType: EventType) => {
        let pending = turnAvailability.get(eventType.key);
        if (!pending) {
          pending = availableSlots(eventType, visitorTimeZone).catch(error => { turnAvailability.delete(eventType.key); throw error; });
          turnAvailability.set(eventType.key, pending);
        }
        return pending;
      } }
      : undefined,
  };
  const sources: SourceHit[] = [];
  const readResults = new Map<string, ToolOutcome>();
  const startedAt = Date.now();
  const usage: TurnState['usage'] = {};
  const stepFirstMs: number[] = [];
  const stepMs: number[] = [];
  // What gets recorded about this answer once it ends, however it ends. No text, no session.
  let steps = 0;
  const toolsRun: string[] = [];
  let outcome: 'complete' | 'truncated' | 'error' | 'timeout' | 'aborted' = 'error';
  const turn: TurnState = {
    // Every event is recorded while it may still be cached; a session-bound event or a failed tool rules it out.
    recorded: cacheKey ? [] : undefined,
    answer: '', firstTokenMs: undefined, toolMs: 0, startedAt, sources, readResults, usage, stepFirstMs, stepMs, toolsRun,
  };
  try {
    let finish: string | null = null;
    // Reserve one artifact-only step so research cannot consume the document's creation budget.
    const finalStep = config.MAX_TOOL_STEPS + (storage.configured && config.MAX_TOOL_STEPS > 0 ? 1 : 0);
    for (let step = 0; step <= finalStep; step++) {
      const stepTools = step < config.MAX_TOOL_STEPS ? toolDefinitions
        : step < finalStep ? toolDefinitions.filter(tool => tool.function.name === 'create_artifact') : [];
      const canUseTools = stepTools.length > 0;
      if (step === config.MAX_TOOL_STEPS && canUseTools) conversation.push({ role: 'system', content: 'Research is complete for this turn. Only create_artifact remains available. If the visitor requested a downloadable document and none was successfully created, create it now from the evidence already collected, noting any gaps. Do not request more research or repeat a successful artifact. Otherwise give your final answer.' });
      if (!canUseTools) conversation.push({ role: 'system', content: 'The tool budget is exhausted. No more tools can run in this turn. Answer using only results already received. Do not simulate tool calls in text or promise more work. If a requested document was not successfully created, say it is unavailable; otherwise point to its Download Markdown button.' });
      // Timed from the request, not from the first byte: connecting and queueing are part of the step.
      const stepStarted = Date.now();
      const response = await client.chat.completions.create({
        model: config.OPENROUTER_MODEL, messages: conversation, stream: true, max_tokens: config.MAX_OUTPUT_TOKENS,
        stream_options: { include_usage: true },
        ...(canUseTools ? { tools: stepTools, tool_choice: 'auto' as const } : {}),
        // OpenRouter's unified reasoning control; unset leaves the provider's default.
        ...(config.CHAT_REASONING_EFFORT ? { reasoning: { effort: config.CHAT_REASONING_EFFORT } } : {}),
      } as OpenAI.Chat.ChatCompletionCreateParamsStreaming, { signal: controller.signal });
      steps++;
      const { calls, stepText, finish: stepFinish } = await readStep(response, stepStarted, canUseTools, turn, send, alive);
      finish = stepFinish;
      const requested = calls.filter(call => call?.name);
      if (requested.some(call => !stepTools.some(tool => tool.function.name === call.name))) throw new Error('Tool unavailable in this step');
      if (!requested.length) break;
      conversation.push({ role: 'assistant', content: stepText || null, tool_calls: requested.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) });
      await runToolCalls(deps, { requested, toolContext, conversation, controller, sessionId, visitorTimeZone }, turn, send, alive);
      if (sources.length) await send({ type: 'sources', sources });
    }
    if (finish !== 'stop' && finish !== 'length') throw new Error('Incomplete provider response');
    if (!turn.answer.trim()) throw new Error('Empty provider response');
    if (finish === 'stop' && options.genUi) {
      try {
        const ui = await options.genUi({ message, answer: turn.answer, sources }, controller.signal);
        if (ui) await send({ type: 'ui', ui });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        console.error('Jev UI composition failed');
      }
    }
    // Only a whole answer is reused; one cut off at the length limit is not.
    if (cacheKey && turn.recorded && finish === 'stop') {
      await db.cacheAnswer(cacheKey, turn.recorded, config.ANSWER_CACHE_TTL_HOURS).catch(error => console.error('Could not cache answer:', error.message));
    }
    await send({ type: 'usage', usage: { ms: Date.now() - startedAt, model: config.OPENROUTER_MODEL, ...usage } });
    await send({ type: 'done', finishReason: finish });
    outcome = finish === 'length' ? 'truncated' : 'complete';
  } catch {
    outcome = stream.aborted ? 'aborted' : controller.signal.aborted ? 'timeout' : 'error';
    if (!stream.aborted) await send({ type: 'error', message: controller.signal.aborted ? 'Response timed out. Please retry.' : 'The model could not finish this answer. Please retry.' });
  } finally {
    clearTimeout(idle); clearTimeout(ceiling); controller.abort(); concurrency.active--;
    void db.recordMetric({
      kind: 'chat', outcome, totalMs: Date.now() - startedAt, firstTokenMs: turn.firstTokenMs, model: config.OPENROUTER_MODEL, ...usage,
      steps, tools: toolsRun, toolMs: turn.toolMs, sources: sources.length, stepFirstMs, stepMs, origin,
    }).catch(error => console.error('Could not record metric:', error.message));
  }
}
