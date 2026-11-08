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
