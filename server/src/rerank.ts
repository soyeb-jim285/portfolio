// Reorders a search's top candidates with a small model reading the actual code. Retrieval finds the
// right file often but ranks it low; a model that sees question and code together can fix the order.
// Only ever reorders what search returned: it cannot add a file, and any failure keeps the fused order.
import type OpenAI from 'openai';

export type Candidate = { repo: string; path: string; symbols: string[]; startLine: number; endLine: number; content: string };
export type Reranker = (query: string, candidates: Candidate[]) => Promise<number[]>;

const PREVIEW_LINES = 30;
const PREVIEW_CHARS = 1200;

export function createReranker(client: OpenAI, model: string, timeoutMs = 8000): Reranker {
  return async (query, candidates) => {
    const listing = candidates.map((candidate, index) => {
      const preview = candidate.content.split('\n').slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS);
      return `[${index}] ${candidate.repo}/${candidate.path}:${candidate.startLine}-${candidate.endLine}${candidate.symbols.length ? ` (${candidate.symbols.slice(0, 8).join(', ')})` : ''}\n${preview}`;
    }).join('\n\n');
    const response = await client.chat.completions.create({
      model, temperature: 0, max_tokens: 200, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You rank code search results. Given a question and numbered code excerpts, return JSON {"ranking":[...]} listing the excerpt numbers from most to least useful for answering the question. Prefer the file that implements the behaviour over files that only mention it. Include every number once.' },
        { role: 'user', content: `Question: ${query}\n\n${listing}` },
      ],
    }, { timeout: timeoutMs });
    const parsed = JSON.parse(response.choices[0]?.message?.content ?? '{}') as { ranking?: unknown };
    const seen = new Set<number>();
    const order: number[] = [];
    for (const value of Array.isArray(parsed.ranking) ? parsed.ranking : []) {
      const index = Number(value);
      if (Number.isInteger(index) && index >= 0 && index < candidates.length && !seen.has(index)) { seen.add(index); order.push(index); }
    }
    // Anything the model skipped keeps its fused position after the ranked ones.
    for (let index = 0; index < candidates.length; index++) if (!seen.has(index)) order.push(index);
    return order;
  };
}
