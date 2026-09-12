// OpenRouter's embeddings endpoint, used for both indexing and query time so vectors are comparable.
const MAX_INPUT_CHARS = 6000;
const BATCH = 32;

export type Embedder = { model: string; dims: number; embed(texts: string[]): Promise<number[][]> };

export function createEmbedder(apiKey: string, model: string, dims: number, fetchImpl: typeof fetch = fetch): Embedder {
  async function call(input: string[]) {
    let lastError = new Error('Embedding request failed');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      try {
        const response = await fetchImpl('https://openrouter.ai/api/v1/embeddings', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input }),
        });
        if (!response.ok) throw new Error(`Embedding request failed (${response.status})`);
        const body = await response.json() as { data?: { embedding: number[]; index?: number }[] };
        const vectors = (body.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(entry => entry.embedding);
        if (vectors.length !== input.length) throw new Error('Embedding provider returned the wrong number of vectors');
        // A dimension mismatch would silently poison the index, so refuse it here.
        for (const vector of vectors) if (vector?.length !== dims) throw new Error(`Expected ${dims}-dimension embeddings, received ${vector?.length}`);
        return vectors;
      } catch (error) { lastError = error instanceof Error ? error : new Error(String(error)); }
    }
    throw lastError;
  }

  return {
    model, dims,
    async embed(texts) {
      const trimmed = texts.map(text => text.slice(0, MAX_INPUT_CHARS));
      const vectors: number[][] = [];
      for (let index = 0; index < trimmed.length; index += BATCH) vectors.push(...await call(trimmed.slice(index, index + BATCH)));
      return vectors;
    },
  };
}

export const toVectorLiteral = (vector: number[]) => `[${vector.join(',')}]`;
