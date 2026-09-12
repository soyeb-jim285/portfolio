// Which repositories may be indexed. The list is discovered from GitHub rather than written by
// hand, but the rules below are the allowlist: nothing outside them is ever fetched or quoted.
import type { RemoteRepo } from './github';

export type Repo = { name: string; owner: string; url: string; branch: string; blurb: string; language?: string; topics?: string[]; stars?: number; openIssues?: number; pushedAt?: string };

// Repositories to leave out by name, whatever GitHub reports.
export const EXCLUDED = new Set(['hyprfm-flatpak-repo']);

export const selectRepos = (remote: RemoteRepo[]): (Repo & { pushedAt: string })[] => remote
  .filter(repo => !EXCLUDED.has(repo.name))
  .map(repo => ({
    name: repo.name, owner: repo.owner, url: repo.url, branch: repo.branch,
    blurb: repo.description || `${repo.language || 'Source'} repository`,
    language: repo.language, topics: repo.topics, stars: repo.stars, openIssues: repo.openIssues, pushedAt: repo.pushedAt,
  }));

export const sourceUrl = (repo: { url: string }, commit: string, path: string, startLine?: number, endLine?: number) =>
  `${repo.url.replace(/\.git$/, '')}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}${startLine ? `#L${startLine}${endLine && endLine !== startLine ? `-L${endLine}` : ''}` : ''}`;
