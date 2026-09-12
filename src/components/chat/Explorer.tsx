import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink, FileCode, GitBranch, Search, Star } from 'lucide-react';
import { Button } from '../ui/button';
import Diagram from './Diagram';
import { MessageResponse } from '../ai-elements/message';
import { loadFile, loadGraph, loadRepos, loadTree, type RepoCard, type RepoFile, type RepoGraph, type RepoTree } from '../../lib/chat-stream';

export type ExplorerTarget = { repo?: string; path?: string; line?: number };

const shortDate = (iso: string) => iso ? new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(new Date(iso)) : '';
const fence = (language: string, content: string) => `\`\`\`${language || 'text'}\n${content}\n\`\`\``;

// Mermaid source is generated from parsed edges only; nothing here is written by a model.
const graphSource = (graph: RepoGraph) => {
  const id = (value: string) => `n${[...value].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) % 100000, 7)}_${value.replace(/[^a-z0-9]/gi, '').slice(-12) || 'root'}`;
  const label = (node: RepoGraph['nodes'][number]) => `${node.id.split('/').slice(-2).join('/')}<br/>${node.files} files`;
  return [
    'flowchart LR',
    ...graph.nodes.map(node => `  ${id(node.id)}["${label(node)}"]`),
    ...graph.edges.map(edge => `  ${id(edge.from)} -->|${edge.weight}| ${id(edge.to)}`),
  ].join('\n');
};

export default function Explorer({ endpoint, token, target, onClose, onAsk }: {
  endpoint: string; token: string | undefined; target: ExplorerTarget; onClose: () => void; onAsk: (question: string) => void;
}) {
  const [repos, setRepos] = useState<RepoCard[]>([]);
  const [repo, setRepo] = useState(target.repo ?? '');
  const [tree, setTree] = useState<RepoTree | null>(null);
  const [file, setFile] = useState<RepoFile | null>(null);
  const [graph, setGraph] = useState<RepoGraph | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token || repo) return;
    setBusy(true);
    loadRepos(endpoint, token).then(setRepos).catch(problem => setError(problem.message)).finally(() => setBusy(false));
  }, [endpoint, token, repo]);

  useEffect(() => {
    if (!token || !repo) return;
    setBusy(true); setError(''); setTree(null); setGraph(null);
    Promise.all([loadTree(endpoint, token, repo), loadGraph(endpoint, token, repo).catch(() => null)])
      .then(([loadedTree, loadedGraph]) => { setTree(loadedTree); setGraph(loadedGraph); })
      .catch(problem => setError(problem.message))
      .finally(() => setBusy(false));
  }, [endpoint, token, repo]);

  useEffect(() => {
    if (!token || !repo || !target.path) return;
    loadFile(endpoint, token, repo, target.path).then(setFile).catch(problem => setError(problem.message));
  }, [endpoint, token, repo, target.path]);

  const open = (path: string) => {
    if (!token) return;
    setBusy(true); setError('');
    loadFile(endpoint, token, repo, path).then(setFile).catch(problem => setError(problem.message)).finally(() => setBusy(false));
  };

  const files = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = tree?.files ?? [];
    return needle ? all.filter(entry => entry.path.toLowerCase().includes(needle)) : all;
  }, [tree, filter]);

  if (!repo) return <section className="explorer" aria-label="Repositories">
    <header className="explorer-head">
      <Button type="button" variant="ghost" onClick={onClose}><ArrowLeft size={14} aria-hidden="true" /> Back to chat</Button>
      <span>{repos.length ? `${repos.length} repositories indexed` : busy ? 'Loading…' : ''}</span>
    </header>
    {error && <p className="explorer-error">{error}</p>}
    <div className="explorer-grid">
      {repos.map(card => <article key={card.repo}>
        <button type="button" onClick={() => setRepo(card.repo)}>
          <h4>{card.repo}</h4>
          <p>{card.description}</p>
        </button>
        <dl>
          {card.stars > 0 && <div><dt><Star size={10} aria-hidden="true" /> stars</dt><dd>{card.stars}</dd></div>}
          {card.language && <div><dt>language</dt><dd>{card.language}</dd></div>}
          <div><dt>files</dt><dd>{card.files}</dd></div>
          <div><dt>edges</dt><dd>{card.edges}</dd></div>
          {card.pushedAt && <div><dt>pushed</dt><dd>{shortDate(card.pushedAt)}</dd></div>}
        </dl>
      </article>)}
    </div>
  </section>;

  return <section className="explorer" aria-label={`${repo} source`}>
    <header className="explorer-head">
      <Button type="button" variant="ghost" onClick={() => (file ? setFile(null) : target.repo ? onClose() : setRepo(''))}>
        <ArrowLeft size={14} aria-hidden="true" /> {file ? 'Files' : target.repo ? 'Back to chat' : 'Repositories'}
      </Button>
      <span className="explorer-repo">{repo}{tree ? ` @ ${tree.commit.slice(0, 8)}` : ''}</span>
    </header>
    {error && <p className="explorer-error">{error}</p>}

    {file ? <div className="explorer-file">
      <div className="explorer-file-head">
        <span><FileCode size={12} aria-hidden="true" /> {file.path}</span>
        <span className="explorer-file-meta">
          {file.lineCount} lines{file.truncated ? ', showing the first 2000' : ''}
          {file.url && <> · <a href={file.url} target="_blank" rel="noopener noreferrer">GitHub <ExternalLink size={10} aria-hidden="true" /></a></>}
        </span>
      </div>
      <div className="explorer-code">
        <MessageResponse skipHtml disallowedElements={['img']} linkSafety={{ enabled: false }}
          codeBlockMaxHeight={0} controls={{ code: { copy: true, download: false }, table: false }}>
          {fence(file.language, file.content)}
        </MessageResponse>
      </div>
      <Button type="button" onClick={() => onAsk(`In ${repo}, explain ${file.path}.`)}>Ask about this file</Button>
    </div> : <>
      {graph && graph.nodes.length > 1 && <div className="explorer-graph">
        <p className="explorer-section"><GitBranch size={12} aria-hidden="true" /> {graph.moduleCount} modules · {graph.edgeCount} parsed dependencies{graph.truncated ? ' · busiest shown' : ''}</p>
        <Diagram source={graphSource(graph)} title={`${repo} modules`} />
      </div>}
      <label className="explorer-filter">
        <Search size={12} aria-hidden="true" />
        <input value={filter} onChange={event => setFilter(event.target.value)} placeholder={`Filter ${tree?.files.length ?? 0} files`} />
      </label>
      <ul className="explorer-files">
        {files.slice(0, 400).map(entry => <li key={entry.path}>
          <button type="button" onClick={() => open(entry.path)}>
            <span>{entry.path}</span><small>{entry.lines}</small>
          </button>
        </li>)}
        {files.length > 400 && <li className="explorer-more">{files.length - 400} more, narrow the filter</li>}
        {!busy && !files.length && <li className="explorer-more">No file matches that filter.</li>}
      </ul>
    </>}
  </section>;
}
