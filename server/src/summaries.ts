// One-sentence descriptions of indexed files, so a question in plain words ("how does it decide when
// a word comes back?") can find code whose identifiers share none of its words (FSRS.swift).
// Written once per distinct file content by a small model and reused across revisions by hash.
import type OpenAI from 'openai';
import type { Pool } from 'pg';
import { clipForEmbedding, toVectorLiteral, type Embedder } from './embeddings';

const HEAD_LINES = 200;
const CONCURRENCY = 4;

const PROMPT = `You describe one source file from a developer's public repositories so that people can find it by asking questions in plain words.
Write one or two sentences, at most 60 words, on what the file does and which behaviour or feature it implements.
Use the everyday words someone would use when asking about that behaviour (for example "schedules when a word is reviewed again", not only the algorithm's name), then name the key technique.
No preamble, no file name, no markdown.`;

export type Summarizer = { client: OpenAI; model: string };

async function describe(summarizer: Summarizer, repo: string, path: string, content: string) {
  const head = content.split('\n').slice(0, HEAD_LINES).join('\n');
  const response = await summarizer.client.chat.completions.create({
    model: summarizer.model, temperature: 0, max_tokens: 120,
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: `Repository: ${repo}\nPath: ${path}\n\n${clipForEmbedding(head)}` },
    ],
  }, { timeout: 30_000 });
  const text = response.choices[0]?.message?.content?.replace(/\s+/g, ' ').trim() ?? '';
  return text.slice(0, 600);
}

/**
 * Fills in missing summaries for live files. Reuses any existing summary of identical content first,
 * then writes the rest. Best effort: a file that cannot be described keeps a null summary and the
 * code search still works without it.
 */
export async function summarizeMissing(pool: Pool, summarizer: Summarizer, embedder: Embedder, options: { limit?: number; log?: (message: string) => void } = {}) {
  const log = options.log ?? (message => console.log(message));
  // Identical content already described under this model, in any revision, costs nothing.
  const reused = await pool.query(
    `UPDATE source_files f SET summary = prior.summary, summary_model = prior.summary_model, summary_embedding = prior.summary_embedding
     FROM (SELECT DISTINCT ON (content_hash) content_hash, summary, summary_model, summary_embedding
           FROM source_files WHERE summary IS NOT NULL AND summary_embedding IS NOT NULL AND summary_model = $1
           ORDER BY content_hash, id DESC) prior
     WHERE f.summary IS NULL AND f.content_hash = prior.content_hash
       AND f.revision_id IN (SELECT id FROM index_revisions WHERE status = 'live')`, [summarizer.model]);
  const { rows } = await pool.query<{ id: string; repo: string; path: string; content: string }>(
    `SELECT f.id, r.repo, f.path, f.content FROM source_files f JOIN index_revisions r ON r.id = f.revision_id
     WHERE r.status = 'live' AND f.summary IS NULL ORDER BY r.repo, f.path LIMIT $1`, [options.limit ?? 5000]);
  if (!rows.length) { if (reused.rowCount) log(`summaries: ${reused.rowCount} reused, none to write`); return { reused: reused.rowCount ?? 0, written: 0, failed: 0 }; }
  log(`summaries: ${reused.rowCount ?? 0} reused, ${rows.length} to write with ${summarizer.model}`);

  let written = 0;
  let failed = 0;
  const done: { id: string; summary: string; embedText: string }[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < rows.length) {
      const file = rows[next++];
      try {
        const summary = await describe(summarizer, file.repo, file.path, file.content);
        if (summary) done.push({ id: file.id, summary, embedText: `${file.repo}/${file.path}\n${summary}` });
        else failed++;
      } catch { failed++; }
    }
  }));

  for (let offset = 0; offset < done.length; offset += 64) {
    const batch = done.slice(offset, offset + 64);
    try {
      const vectors = await embedder.embed(batch.map(item => item.embedText));
      for (let index = 0; index < batch.length; index++) {
        await pool.query('UPDATE source_files SET summary = $2, summary_model = $3, summary_embedding = $4::vector WHERE id = $1',
          [batch[index].id, batch[index].summary, summarizer.model, toVectorLiteral(vectors[index])]);
        written++;
      }
    } catch (error) {
      failed += batch.length;
      log(`summaries: a batch could not be embedded — ${error instanceof Error ? error.message : error}`);
    }
  }
  log(`summaries: ${written} written, ${failed} failed`);
  return { reused: reused.rowCount ?? 0, written, failed };
}
