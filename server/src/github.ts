// GitHub read-only client. A token is optional but lifts the 60 requests per hour anonymous
// limit; without one, discovery degrades rather than fails.
const API = 'https://api.github.com';

export type RemoteRepo = {
  name: string; owner: string; url: string; branch: string; description: string;
  stars: number; language: string; topics: string[]; pushedAt: string; openIssues: number; sizeKb: number;
};
export type TreeEntry = { path: string; size: number };

export function createGitHub(token: string | undefined, fetchImpl: typeof fetch = fetch) {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'portfolio-assistant',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  async function get<T>(path: string): Promise<T> {
    const response = await fetchImpl(`${API}${path}`, { headers, signal: AbortSignal.timeout(20000) });
    if (response.status === 403 || response.status === 429) throw new Error('GitHub rate limit reached; set GITHUB_TOKEN');
    if (!response.ok) throw new Error(`GitHub request failed (${response.status}) for ${path}`);
    return await response.json() as T;
  }

  return {
    authenticated: Boolean(token),
    // GET only. Callers build the path from validated arguments; see github_activity in tools.ts.
    get,

    async repos(owner: string): Promise<RemoteRepo[]> {
      const pages: RemoteRepo[] = [];
      for (let page = 1; page <= 5; page++) {
        const batch = await get<any[]>(`/users/${owner}/repos?per_page=100&type=owner&page=${page}`);
        for (const repo of batch) {
          if (repo.fork || repo.archived || repo.disabled || !repo.size) continue;
          pages.push({
            name: repo.name, owner: repo.owner.login, url: repo.html_url, branch: repo.default_branch,
            description: repo.description ?? '', stars: repo.stargazers_count, language: repo.language ?? '',
            topics: repo.topics ?? [], pushedAt: repo.pushed_at, openIssues: repo.open_issues_count, sizeKb: repo.size,
          });
        }
        if (batch.length < 100) break;
      }
      return pages;
    },

    // Paths and sizes for the whole tree in one request, without downloading any file.
    async tree(owner: string, repo: string, ref: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
      const body = await get<{ tree?: { path: string; type: string; size?: number }[]; truncated?: boolean }>(
        `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      return {
        entries: (body.tree ?? []).filter(entry => entry.type === 'blob').map(entry => ({ path: entry.path, size: entry.size ?? 0 })),
        truncated: Boolean(body.truncated),
      };
    },
  };
}

export type GitHub = ReturnType<typeof createGitHub>;
