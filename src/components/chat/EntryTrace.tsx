import { ExternalLink } from 'lucide-react';
import { MessageResponse } from '../ai-elements/message';
import { Fold } from './ChatPrimitives';
import { MARKDOWN, type Entry } from './panel-shared';

export default function EntryTrace({ entry }: { entry: Entry }) {
  return (!!entry.tools?.length || !!entry.sources?.length || entry.usage) && <details className="chat-trace" open={entry.state === 'streaming' && !entry.content}>
    <summary>
      <span className="chat-trace-facts">
        {!!entry.tools?.length && `${entry.tools.length} ${entry.tools.length === 1 ? 'step' : 'steps'}`}
        {!!entry.sources?.length && `${entry.tools?.length ? ' · ' : ''}${entry.sources.length} ${entry.sources.length === 1 ? 'source' : 'sources'}`}
        {entry.usage && `${entry.tools?.length || entry.sources?.length ? ' · ' : ''}${entry.usage.cached ? 'cached' : `${(entry.usage.ms / 1000).toFixed(1)}s`}`}
      </span>
      {entry.usage?.promptTokens !== undefined && <span className="chat-trace-cost">
        {((entry.usage.promptTokens + (entry.usage.completionTokens ?? 0)) / 1000).toFixed(1)}k tokens
        {entry.usage.costUsd !== undefined && ` · $${entry.usage.costUsd.toFixed(4)}`}
      </span>}
    </summary>
    {!!entry.tools?.length && <ul className="chat-tools">
      {entry.tools.map(tool => <li key={tool.id} data-status={tool.status}>
        <span className="chat-tool-mark" aria-hidden="true">{tool.status === 'running' ? '·' : tool.status === 'error' ? '×' : '✓'}</span>
        <span className="chat-tool-name">{tool.name.replace(/_/g, ' ')}</span>
        <span className="chat-tool-summary">{tool.status === 'running' ? 'running' : tool.summary}</span>
        {tool.ms !== undefined && <span className="chat-tool-ms">{tool.ms} ms</span>}
      </li>)}
    </ul>}
    {!!entry.sources?.length && <div className="chat-sources">
      {/* One line per file; the lines it read open on demand instead of arriving as a wall of code. */}
      {entry.sources.map(source => <Fold key={`${source.repo}:${source.path}:${source.startLine}-${source.endLine}`} className="chat-source" summary={<>
        <span className="chat-source-path">{source.repo}/{source.path}:{source.startLine}-{source.endLine}</span>
        {/* An empty href would reload this page, so a citation without a URL gets no link at all. */}
        {source.url && <a className="chat-source-open" href={source.url} target="_blank" rel="noopener noreferrer" aria-label="Open these lines on GitHub" title="Open on GitHub">
          <ExternalLink size={11} aria-hidden="true" />
        </a>}
      </>}>{() => <>
        <span className="chat-source-meta">@ {source.commit.slice(0, 8)}{source.symbols.length ? ` · ${source.symbols.slice(0, 4).join(', ')}` : ''}</span>
        <MessageResponse {...MARKDOWN} codeBlockMaxHeight={260}>
          {`\`\`\`${source.language || 'text'}\n${source.snippet}\n\`\`\``}
        </MessageResponse>
      </>}</Fold>)}
    </div>}
  </details>;
}
