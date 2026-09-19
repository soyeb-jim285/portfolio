import type { ToolActivity } from './chat-stream';

type Detail = Record<string, string | undefined>;
const quoted = (text = '') => text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text;
const file = (path = '') => path.split('/').pop() || path;
const own = (repo?: string) => repo ? `${repo}'s` : 'the';

const github: Record<string, (detail: Detail) => string> = {
  overview: ({ repo }) => `Checking ${repo ?? 'the repository'} on GitHub…`,
  commits: ({ repo }) => `Looking at ${own(repo)} latest commits on GitHub…`,
  search: ({ repo, query }) => query ? `Searching ${own(repo)} commits for “${quoted(query)}”…` : `Searching ${own(repo)} commits…`,
  history: ({ path }) => path ? `Tracing the history of ${file(path)}…` : 'Tracing the file history…',
  commit: ({ sha }) => sha ? `Opening commit ${sha.slice(0, 7)} on GitHub…` : 'Opening the commit on GitHub…',
  pulls: ({ repo }) => `Looking at ${own(repo)} pull requests…`,
  issues: ({ repo }) => `Looking at ${own(repo)} issues…`,
  thread: ({ number }) => number ? `Reading #${number} on GitHub…` : 'Reading the thread on GitHub…',
  releases: ({ repo }) => `Checking ${own(repo)} releases…`,
  contributors: ({ repo }) => `Looking at who contributes to ${repo ?? 'the repository'}…`,
};

const labels: Record<string, (detail: Detail) => string> = {
  search_knowledge: ({ query, repo }) => query ? `Searching ${repo ?? 'the code'} for “${quoted(query)}”…` : `Searching ${repo ?? 'the code'}…`,
  read_source: ({ path, repo }) => path ? `Reading ${file(path)}${repo ? ` in ${repo}` : ''}…` : 'Reading the source…',
  list_files: ({ repo }) => `Looking through ${own(repo)} files…`,
  portfolio_details: ({ slug }) => slug ? `Reading the ${slug} write-up…` : 'Reading the project write-up…',
  github_activity: detail => (github[detail.kind ?? ''] ?? github.overview)(detail),
  create_artifact: () => 'Writing your document…',
  show_section: () => 'Finding the right part of the site…',
  show_image: () => 'Picking a screenshot…',
  prepare_contact: () => 'Drafting your message…',
  get_availability: () => "Checking Jim's calendar…",
  propose_booking: () => 'Preparing the meeting details…',
};

export function workingLabel(tools: ToolActivity[] = [], hasText = false) {
  const active = tools.findLast(tool => tool.status === 'running');
  if (active) return labels[active.name]?.(active.detail ?? {}) ?? 'Working on it…';
  if (hasText) return 'Writing…';
  if (tools.length) return 'Going through what I found…';
  return 'Thinking…';
}
