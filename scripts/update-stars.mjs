// Refreshes the GitHub counts that are baked into the site and the resume.
// Run by .github/workflows/update-stars.yml once a day; safe to run by hand.
//
// Sources of truth it rewrites:
//   src/data/content.ts  — projects[].stars / .forks / .contributors (hyprfm) and the Stars fact
//   src/data/cv.json     — open_source[].stars and github_stats.total_stars
//   outputs/*.tex        — the "N GitHub stars" claim in the resume
import { readFile, writeFile } from 'node:fs/promises';

const USER = 'soyeb-jim285';
const TRACKED = 'hyprfm'; // the repo whose counts appear on the site and the resume

const gh = async (path) => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${path} returned ${response.status}`);
  return { body: await response.json(), headers: response.headers };
};

// The contributors endpoint has no count, so ask for one per page and read the last page number.
const contributorCount = async (repo) => {
  const { body, headers } = await gh(`/repos/${USER}/${repo}/contributors?per_page=1&anon=1`);
  const last = /[?&]page=(\d+)>; rel="last"/.exec(headers.get('link') ?? '');
  return last ? Number(last[1]) : body.length;
};

const { body: repos } = await gh(`/users/${USER}/repos?per_page=100&sort=updated`);
const tracked = repos.find((repo) => repo.name === TRACKED);
if (!tracked) throw new Error(`${TRACKED} not found in the repo list`);

const stars = tracked.stargazers_count;
const forks = tracked.forks_count;
const contributors = await contributorCount(TRACKED);
const totalStars = repos.reduce((sum, repo) => sum + repo.stargazers_count, 0);
const starsByRepo = new Map(repos.map((repo) => [repo.name.toLowerCase(), repo.stargazers_count]));

const edit = async (path, replacer) => {
  let before;
  try {
    before = await readFile(path, 'utf8');
  } catch {
    return false; // outputs/ is not always present (it is gitignored locally)
  }
  const after = replacer(before);
  if (after === before) return false;
  await writeFile(path, after);
  console.log(`updated ${path}`);
  return true;
};

await edit('src/data/content.ts', (text) =>
  text
    .replace(/stars: \d+, forks: \d+, contributors: \d+,/, `stars: ${stars}, forks: ${forks}, contributors: ${contributors},`)
    .replace(/\{ label: 'Stars', value: '\d+' \}/, `{ label: 'Stars', value: '${stars}' }`));

await edit('src/data/cv.json', (text) => {
  const withRepoStars = text.replace(/\{ "name": "([^"]+)",\s*"stars": \d+/g, (match, name) => {
    const fresh = starsByRepo.get(name.toLowerCase());
    return fresh === undefined ? match : match.replace(/"stars": \d+/, `"stars": ${fresh}`);
  });
  return withRepoStars
    .replace(/("name": "HyprFM"[\s\S]{0,200}?"stars": )\d+/, `$1${stars}`)
    .replace(/("total_stars": \{ "v": )\d+/, `$1${totalStars}`);
});

await edit('outputs/Soyeb_Pervez_Jim_Resume.tex', (text) =>
  text.replace(/\d+ GitHub stars/, `${stars} GitHub stars`));

console.log(`${TRACKED}: ${stars} stars, ${forks} forks, ${contributors} contributors; ${totalStars} stars across all repos`);
