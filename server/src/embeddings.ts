// OpenRouter's embeddings endpoint, used for both indexing and query time so vectors are comparable.
import { createHash } from 'node:crypto';
const MAX_INPUT_CHARS = 6000;
// The model rejects any input over ~8K tokens, and one oversized input fails the whole batch. A
// character cap is only safe for English (~4 characters a token): 6,000 characters of Chinese
// can pass 9,000 tokens. So the cap counts estimated tokens, pessimistic for anything non-ASCII.
// ponytail: an estimate, not a tokenizer; a real one is the upgrade if a 400 ever recurs.
const MAX_INPUT_TOKENS = 6000;
export function clipForEmbedding(text: string) {
  let tokens = 0;
  let end = 0;
  for (const character of text) {
    tokens += character.charCodeAt(0) < 128 ? 0.3 : 2;
    if (tokens > MAX_INPUT_TOKENS || end >= MAX_INPUT_CHARS) break;
    end += character.length;
  }
  return text.slice(0, end);
}
const BATCH = 32;

export type Embedder = { model: string; dims: number; embed(texts: string[]): Promise<number[][]> };

export function createEmbedder(apiKey: string, model: string, dims: number, fetchImpl: typeof fetch = fetch): Embedder {
  // Query embeddings are independent of indexed revisions; share in-flight and recent queries.
  // ponytail: bounded per-process cache; bulk indexing bypasses it.
  const queries = new Map<string, { expires: number; result: Promise<number[][]> }>();
  async function call(input: string[]) {
    let lastError = new Error('Embedding request failed');
    for (let attempt = 0; attempt < 3; attempt++) {
      let retryable = true;
      if (attempt) await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      try {
        const response = await fetchImpl('https://openrouter.ai/api/v1/embeddings', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input }),
          signal: AbortSignal.timeout(10000),
        });
        retryable = response.status === 429 || response.status >= 500;
        if (!response.ok) throw new Error(`Embedding request failed (${response.status})`);
        const body = await response.json() as { data?: { embedding: number[]; index?: number }[] };
        const vectors = (body.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(entry => entry.embedding);
        if (vectors.length !== input.length) throw new Error('Embedding provider returned the wrong number of vectors');
        // A dimension mismatch would silently poison the index, so refuse it here.
        for (const vector of vectors) if (vector?.length !== dims || !vector.every(Number.isFinite)) throw new Error(`Invalid ${dims}-dimension embedding`);
        return vectors;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!retryable) throw lastError;
      }
    }
    throw lastError;
  }

  return {
    model, dims,
    async embed(texts) {
      const trimmed = texts.map(clipForEmbedding);
      if (trimmed.length === 1) {
        const key = createHash('sha256').update(trimmed[0]).digest('hex');
        const cached = queries.get(key);
        if (cached && cached.expires > Date.now()) return cached.result;
        if (queries.size >= 256) queries.delete(queries.keys().next().value!);
        const entry = { expires: Date.now() + 600000, result: call(trimmed) };
        queries.set(key, entry);
        try { return await entry.result; }
        catch (error) { if (queries.get(key) === entry) queries.delete(key); throw error; }
      }
      const vectors: number[][] = [];
      for (let index = 0; index < trimmed.length; index += BATCH) vectors.push(...await call(trimmed.slice(index, index + BATCH)));
      return vectors;
    },
  };
}

export const toVectorLiteral = (vector: number[]) => `[${vector.join(',')}]`;
