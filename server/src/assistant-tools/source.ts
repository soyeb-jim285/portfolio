import { listArgs, readArgs, searchArgs } from './args';
import { asEvidence, fail } from './outcome';
import type { ToolContext, ToolOutcome } from './types';

export async function searchKnowledge(context: ToolContext, parsed: unknown): Promise<ToolOutcome> {
  const { retrieval } = context;
  const repos = context.repoNames;
  const args = searchArgs(repos).safeParse(parsed);
  if (!args.success) return fail('invalid arguments', `Invalid search arguments: ${args.error.issues[0]?.message}`);
  const hits = await retrieval.search(args.data.query, { repo: args.data.repo, limit: args.data.limit });
  const scope = args.data.repo ? ` in ${args.data.repo}` : '';
  if (!hits.length) return fail(`search "${args.data.query}"${scope}: no matches`, 'No indexed code matched that search.');
  return {
    summary: `search "${args.data.query}"${scope}: ${hits.length} match${hits.length === 1 ? '' : 'es'}`,
    result: asEvidence(hits.map(hit =>
      `--- ${hit.repo}/${hit.path}:${hit.startLine}-${hit.endLine} @ ${hit.commit.slice(0, 8)}${hit.url ? ` link: ${hit.url}` : ''}${hit.symbols.length ? ` symbols: ${hit.symbols.join(', ')}` : ''}\n${hit.snippet}`).join('\n\n')),
    sources: hits,
  };
}

export async function readSource(context: ToolContext, parsed: unknown): Promise<ToolOutcome> {
  const { retrieval } = context;
  const repos = context.repoNames;
  const args = readArgs(repos).safeParse(parsed);
  if (!args.success) return fail('invalid arguments', `Invalid read arguments: ${args.error.issues[0]?.message}`);
  const file = await retrieval.read(args.data.repo, args.data.path, args.data.start_line, args.data.end_line);
  if (!file) return fail(`read ${args.data.repo}/${args.data.path}: not indexed`, `${args.data.path} is not in the indexed revision of ${args.data.repo}. Use list_files or search_knowledge for real paths.`);
  return {
    summary: `read ${file.repo}/${file.path}:${file.startLine}-${file.endLine}`,
    result: asEvidence(`--- ${file.repo}/${file.path}:${file.startLine}-${file.endLine} of ${file.lineCount} lines @ ${file.commit.slice(0, 8)}${file.url ? ` link: ${file.url}` : ''}\n${file.content}`),
    sources: [{ repo: file.repo, path: file.path, language: file.language, symbols: [], startLine: file.startLine, endLine: file.endLine, commit: file.commit, url: file.url, snippet: file.content }],
  };
}

export async function listFiles(context: ToolContext, parsed: unknown): Promise<ToolOutcome> {
  const { retrieval } = context;
  const repos = context.repoNames;
  const args = listArgs(repos).safeParse(parsed);
  if (!args.success) return fail('invalid arguments', 'Invalid list arguments.');
  const files = await retrieval.listFiles(args.data.repo);
  if (!files.length) return fail(`list ${args.data.repo}: not indexed`, `${args.data.repo} has no live index.`);
  return {
    summary: `list ${args.data.repo}: ${files.length} files`,
    result: asEvidence(files.map(file => `${file.path} (${file.lines} lines)`).join('\n')),
    sources: [],
  };
}
