// Which repositories may be indexed. The list is discovered from GitHub rather than written by
// hand, but the rules below are the allowlist: nothing outside them is ever fetched or quoted.
import type { RemoteRepo } from './github';

export type Repo = { name: string; owner: string; url: string; branch: string; blurb: string; language?: string; topics?: string[]; stars?: number; openIssues?: number; pushedAt?: string };

// The allowlist: only these repositories are ever fetched, indexed or quoted. Adding a name here
// is the single step that lets the assistant talk about a repository; everything else stays private.
export const INCLUDED = [
  'hyprfm', 'hyprpdf', 'hyprfm-site',
  'soydots', 'quill', 'quill-icons', 'quill-polkit',
  'distrostrap', 'gre-vocab-trainer', 'portfolio',
  'ai4pain-2026-analysis', 'ocr-visualization-', 'LeakNet',
] as const;
const allowed = new Set<string>(INCLUDED);

export const selectRepos = (remote: RemoteRepo[]): (Repo & { pushedAt: string })[] => remote
  .filter(repo => allowed.has(repo.name))
  .map(repo => ({
    name: repo.name, owner: repo.owner, url: repo.url, branch: repo.branch,
    blurb: repo.description || `${repo.language || 'Source'} repository`,
    language: repo.language, topics: repo.topics, stars: repo.stars, openIssues: repo.openIssues, pushedAt: repo.pushedAt,
  }));

export const sourceUrl = (repo: { url: string }, commit: string, path: string, startLine?: number, endLine?: number) =>
  `${repo.url.replace(/\.git$/, '')}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}${startLine ? `#L${startLine}${endLine && endLine !== startLine ? `-L${endLine}` : ''}` : ''}`;
