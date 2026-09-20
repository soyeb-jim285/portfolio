// The counts baked into src/data/content.ts come from scripts/update-stars.mjs, which runs once a
// day. Refresh them in the browser so a quiet month without a deploy cannot leave a page behind.
// Any element with data-gh-repo="owner/name" and data-gh-field gets its text replaced.
type Field = 'stars' | 'forks' | 'contributors' | 'outside';

const counts = async (repo: string): Promise<Record<Field, number>> => {
  const [repoResponse, contributorsResponse] = await Promise.all([
    fetch(`https://api.github.com/repos/${repo}`),
    fetch(`https://api.github.com/repos/${repo}/contributors?per_page=1&anon=1`),
  ]);
  if (!repoResponse.ok || !contributorsResponse.ok) throw new Error('GitHub request failed');

  const repository = await repoResponse.json();
  const firstPage = await contributorsResponse.json();
  // The contributors endpoint has no count, so one per page makes the last page number the count.
  const lastPage = contributorsResponse.headers.get('link')?.match(/[?&]page=(\d+)>; rel="last"/)?.[1];
  const contributors = lastPage ? Number(lastPage) : firstPage.length;
  return {
    stars: repository.stargazers_count,
    forks: repository.forks_count,
    contributors,
    // ponytail: "outside" is everyone but the owner; an owner commit under an unlinked email would count twice.
    outside: Math.max(0, contributors - 1),
  };
};

export async function refreshGitHubStats() {
  const slots = [...document.querySelectorAll<HTMLElement>('[data-gh-repo][data-gh-field]')]
    .filter((slot) => !slot.dataset.ghLoaded);
  for (const repo of new Set(slots.map((slot) => slot.dataset.ghRepo!))) {
    try {
      const fresh = await counts(repo);
      for (const slot of slots.filter((s) => s.dataset.ghRepo === repo)) {
        slot.textContent = fresh[slot.dataset.ghField as Field].toLocaleString();
        slot.dataset.ghLoaded = 'true';
      }
    } catch {
      // Keep the build-time number.
    }
  }
}
