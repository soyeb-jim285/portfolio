import { z } from 'zod';
import { imageIds, targetIds } from '../../../src/data/site-map';
import knowledge from '../knowledge.json' with { type: 'json' };

// Repositories are discovered at index time, so the allowlist is whatever is live right now.
// Case-insensitive, resolved to the indexed spelling: the model writes "leaknet" for "LeakNet".
const canonicalRepo = (repos: string[], value: unknown) => repos.find(repo => repo.toLowerCase() === String(value ?? '').trim().toLowerCase());
const repoArg = (repos: string[]) => z.string().trim().refine(value => Boolean(canonicalRepo(repos, value)), 'Unknown repository').transform(value => canonicalRepo(repos, value)!);
export const searchArgs = (repos: string[]) => z.object({
  query: z.string().trim().min(2).max(400),
  repo: repoArg(repos).optional(),
  limit: z.coerce.number().int().min(1).max(10).optional(),
});
export const readArgs = (repos: string[]) => z.object({
  repo: repoArg(repos),
  path: z.string().trim().min(1).max(400),
  start_line: z.coerce.number().int().min(1).optional(),
  end_line: z.coerce.number().int().min(1).optional(),
});
export const listArgs = (repos: string[]) => z.object({ repo: repoArg(repos) });
export const showArgs = z.object({ target: z.enum(targetIds as [string, ...string[]]) });
export const imageArgs = z.object({ image: z.enum(imageIds as [string, ...string[]]) });
export const DETAILS = knowledge.details as Record<string, unknown>;
export const detailSlugs = Object.keys(DETAILS);
export const detailArgs = z.object({ slug: z.enum(detailSlugs as [string, ...string[]]) });
const GITHUB_KINDS = ['overview', 'commits', 'search', 'history', 'commit', 'pulls', 'issues', 'thread', 'releases', 'contributors'] as const;
// The model sees this schema in strict mode, so every field is required and the unused ones are
// null. The same schema validates the call; the rules that span fields are refinements.
export const githubArgs = (repos: string[]) => z.strictObject({
  repo: z.enum(repos as [string, ...string[]]),
  kind: z.enum(GITHUB_KINDS).describe('overview: stars, forks, watchers, open issues, licence, last push. commits: latest commits. search: commits whose message matches query. history: the commits that touched one file (path), oldest first, so the first one is when it was added. commit: one commit with its message and the code it changed. pulls, issues: lists. thread: one issue or pull request with its description and comments. releases. contributors.'),
  sha: z.string().regex(/^[0-9a-fA-F]{7,40}$/).nullable().describe('For kind commit: the sha, at least 7 characters, from a commits listing. Otherwise null.'),
  number: z.number().int().min(1).nullable().describe('For kind thread: the issue or pull request number. Otherwise null.'),
  query: z.string().min(2).max(100).nullable().describe('For kind search: plain words to find in commit messages, such as "trash restore". Otherwise null.'),
  path: z.string().min(1).max(300).refine(value => !value.split('/').includes('..'), 'Not a repository path').nullable().describe('For kind history: a repository-relative file path, as search_knowledge returns it. Otherwise null.'),
  state: z.enum(['open', 'closed', 'all']).nullable().describe('For pulls and issues; null means open.'),
  limit: z.number().int().min(1).max(20).nullable().describe('How many items; null means 10.'),
}).superRefine((args, context) => {
  if (args.kind === 'commit' && !args.sha) context.addIssue({ code: 'custom', path: ['sha'], message: 'kind commit needs a sha: call kind commits first' });
  if (args.kind === 'search' && !args.query) context.addIssue({ code: 'custom', path: ['query'], message: 'kind search needs a query' });
  if (args.kind === 'history' && !args.path) context.addIssue({ code: 'custom', path: ['path'], message: 'kind history needs a path: find the file with search_knowledge first' });
  if (args.kind === 'thread' && !args.number) context.addIssue({ code: 'custom', path: ['number'], message: 'kind thread needs a number: call kind issues or pulls first' });
});
export type GitHubArgs = z.infer<ReturnType<typeof githubArgs>>;
const GITHUB_FIELDS = ['sha', 'number', 'query', 'path', 'state', 'limit'] as const;
// Providers that ignore strict mode send "" or leave fields out; both mean "not given".
export const normalizeGitHubArgs = (repos: string[], raw: unknown) => {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const args: Record<string, unknown> = { ...value, repo: canonicalRepo(repos, value.repo) ?? value.repo };
  for (const field of GITHUB_FIELDS) if (args[field] === undefined || args[field] === '') args[field] = null;
  if (typeof args.number === 'string' && /^\d+$/.test(args.number)) args.number = Number(args.number);
  if (typeof args.limit === 'string' && /^\d+$/.test(args.limit)) args.limit = Number(args.limit);
  if (typeof args.sha === 'string') args.sha = args.sha.trim();
  return args;
};
export const githubParameters = (repos: string[]) => {
  const { $schema: _schema, ...schema } = z.toJSONSchema(githubArgs(repos), { io: 'input' }) as Record<string, unknown>;
  return schema;
};
export const availabilityArgs = z.object({ duration: z.string().trim().max(16).optional() });
export const proposalArgs = z.object({
  start: z.string().trim().min(10).max(40),
  duration: z.string().trim().max(16).optional(),
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export const ARTIFACT_KINDS = ['brief', 'comparison', 'diagram'] as const;
export const artifactArgs = z.object({
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string().trim().min(3).max(120),
  markdown: z.string().trim().min(50),
});
export const draftArgs = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().max(200).optional(),
  message: z.string().trim().max(4000).optional(),
});
