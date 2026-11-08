import type OpenAI from 'openai';
import type { SourceHit } from '../retrieval';
import type { ToolOutcome } from '../tools';

export type Send = (event: Record<string, unknown>) => Promise<void>;
// One answer's running totals, shared by the turn loop, the provider stream reader and the tool runner.
export type TurnState = {
  recorded: Record<string, unknown>[] | undefined;
  answer: string;
  firstTokenMs: number | undefined;
  toolMs: number;
  startedAt: number;
  sources: SourceHit[];
  readResults: Map<string, ToolOutcome>;
  usage: { promptTokens?: number; completionTokens?: number; costUsd?: number; cachedPromptTokens?: number; reasoningTokens?: number };
  stepFirstMs: number[];
  stepMs: number[];
  toolsRun: string[];
};

// Reads one model step's stream to its end: text goes straight out, tool calls are assembled for the caller.
export async function readStep(response: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>, stepStarted: number, canUseTools: boolean, turn: TurnState, send: Send, alive: () => void) {
  const { usage, stepFirstMs, stepMs } = turn;
  let stepFirst: number | undefined;

  const calls: { id: string; name: string; arguments: string }[] = [];
  let stepText = '';
  let finish: string | null = null;
  for await (const chunk of response) {
    alive();
    stepFirst ??= Date.now() - stepStarted;
    if ('error' in chunk) throw new Error('Provider stream error');
    // Only what the provider actually reports: no estimates, no invented numbers.
    if (chunk.usage) {
      usage.promptTokens = (usage.promptTokens ?? 0) + (chunk.usage.prompt_tokens ?? 0);
      usage.completionTokens = (usage.completionTokens ?? 0) + (chunk.usage.completion_tokens ?? 0);
      const cost = (chunk.usage as { cost?: number }).cost;
      if (typeof cost === 'number') usage.costUsd = (usage.costUsd ?? 0) + cost;
      const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens;
      if (typeof cachedTokens === 'number') usage.cachedPromptTokens = (usage.cachedPromptTokens ?? 0) + cachedTokens;
      const reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens;
      if (typeof reasoningTokens === 'number') usage.reasoningTokens = (usage.reasoningTokens ?? 0) + reasoningTokens;
    }
    const choice = chunk.choices[0];
    if (choice?.delta?.content) {
      turn.firstTokenMs ??= Date.now() - turn.startedAt;
      stepText += choice.delta.content;
      turn.answer += choice.delta.content;
      await send({ type: 'delta', text: choice.delta.content });
    }
    // Ignore tool calls on the final step: no tools were offered, so any are spurious.
    for (const part of (canUseTools ? choice?.delta?.tool_calls : undefined) ?? []) {
      if (!Number.isInteger(part.index) || part.index < 0 || part.index >= 12) throw new Error('Too many tool calls');
      const call = calls[part.index] ??= { id: '', name: '', arguments: '' };
      if (part.id) call.id = part.id;
      if (part.function?.name) call.name += part.function.name;
      if (part.function?.arguments) call.arguments += part.function.arguments;
      if (call.arguments.length > 1_000_000 || call.name.length > 80 || call.id.length > 200) throw new Error('Tool call too large');
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
  }

  stepFirstMs.push(stepFirst ?? Date.now() - stepStarted);
  stepMs.push(Date.now() - stepStarted);
  return { calls, stepText, finish };
}
