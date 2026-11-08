import knowledge from './knowledge.json' with { type: 'json' };

export const MAX_SNIPPET_CHARS = 1500;
// The two best hits carry their whole window: a clipped snippet sent the model back for a
// read_source round trip just to see the line it was about to cite.
export const MAX_TOP_SNIPPET_CHARS = 4000;
export const FULL_WINDOW_HITS = 2;
export const MAX_READ_LINES = 200;
export const MAX_READ_CHARS = 8000;
export const CANDIDATES = 20;
export const RRF_K = 60;
// Which repository a match came from is evidence about relevance, not about truth: a featured,
// starred or recently touched project outranks an old scratch repo when both match equally well.
// It only reorders real matches, and an explicit repo filter makes it moot.
export const FEATURED = (knowledge.featuredRepos as string[]).map(name => name.toLowerCase());

export type SourceHit = {
  repo: string; path: string; language: string; symbols: string[];
  startLine: number; endLine: number; commit: string; url: string; snippet: string;
};
export type IndexedRepo = { repo: string; commit: string; files: number; chunks: number; indexedAt: string; blurb: string; stars: number; language: string; pushedAt: string };

export const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit)}\n… truncated`);
// Repository names arrive from a model or a URL, so they are normalised before they reach a query.
// Names are compared lowercased on both sides: GitHub names keep their case (LeakNet), the model's may not.
export const key = (repo: string) => repo.toLowerCase().trim();

/**
 * How a search is assembled. Each switch is one of the measured improvements, so the evaluation can
 * turn them on one at a time; production uses DEFAULT_VARIANT.
 * - lexical 'and' needs every word of the question in one chunk (only bare identifiers ever matched);
 *   'or' ranks chunks by how many words they contain and where (path and symbols count most).
 * - identifiers: search the camelCase-split, stemmed column, so "draws" meets DrawingCanvas.
 * - weighting 'strong' multiplied scores by up to 2.4 for featured, starred, fresh repositories, which
 *   let any chunk of HyprFM outrank the best chunk elsewhere; 'gentle' only breaks near-ties.
 * - summaries: also rank files by their one-sentence description, in words and in meaning.
 * - rerank: a small model reorders the top candidates after reading them.
 */
export type SearchVariant = {
  lexical: 'and' | 'or'; identifiers: boolean; weighting: 'strong' | 'gentle'; summaries: boolean; rerank: boolean;
};
export const BASELINE_VARIANT: SearchVariant = { lexical: 'and', identifiers: false, weighting: 'strong', summaries: false, rerank: false };
export const DEFAULT_VARIANT: SearchVariant = { lexical: 'or', identifiers: true, weighting: 'gentle', summaries: true, rerank: false };
export const RERANK_POOL = 20;

// Words of the question for an OR query: letters and digits only, so nothing in a question can
// change the query's syntax. camelCase words are split and also kept whole for exact identifiers.
export function queryTerms(query: string) {
  const words = query.match(/[A-Za-z][A-Za-z0-9]*|[0-9]+/g) ?? [];
  const lower = (list: string[]) => [...new Set(list.map(word => word.toLowerCase()).filter(word => word.length >= 2))].slice(0, 32);
  return {
    split: lower(words.flatMap(word => word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' '))).join(' | '),
    whole: lower(words).join(' | '),
  };
}
