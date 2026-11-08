import { Check, Compass, Copy, Download, FileText, RotateCcw, ThumbsDown, ThumbsUp } from 'lucide-react';
import ArtifactView from './ArtifactView';
import Diagram from './Diagram';
import GeneratedUI from './GeneratedUI';
import EntryTrace from './EntryTrace';
import { AudioBubble, Fold } from './ChatPrimitives';
import { EntryDraft, EntryProposals, EntrySlots } from './EntryCards';
import { Button } from '../ui/button';
import { Message, MessageActions, MessageContent, MessageResponse } from '../ai-elements/message';
import { workingLabel } from '../../lib/chat-progress';
import { MARKDOWN, type Entry } from './panel-shared';
import type { EntryActions } from './panel-actions';
import type { Ask } from './panel-ask';
import type { PanelState } from './panel-state';

export default function ChatEntry({ entry, panel, ask, actions }: { entry: Entry; panel: PanelState; ask: Ask; actions: EntryActions }) {
  const { busy, copied, setEntries } = panel;
  const { retryOf, copy, download } = actions;
  return <Message from={entry.role} data-entry={entry.id}>
    <div className="chat-message-label"><span>{entry.role === 'user' ? 'You' : 'Assistant'}</span>{entry.state === 'streaming' && <span className="chat-live-label">Responding</span>}</div>
    <MessageContent>
      {entry.role === 'user' ? <>
        {entry.audio ? <>
          <AudioBubble audio={entry.audio} />
          {/* The transcript is already in hand: opening the fold costs nothing and calls nothing. */}
          <Fold className="chat-transcript" summary="View transcription">{() => <p className="chat-user-text">{entry.audio!.transcript}</p>}</Fold>
        </> : <p className="chat-user-text">{entry.content}</p>}
      </> : entry.content ?
        <MessageResponse isAnimating={entry.state === 'streaming'} {...MARKDOWN}>
          {entry.content}
        </MessageResponse> : entry.state !== 'streaming' ? <p>No answer received.</p> : null}
      {entry.role === 'assistant' && entry.state === 'streaming' && <p className="chat-loading" role="status" aria-live="polite">
        {/* Keyed by its text, so each new step slides in instead of the words swapping in place. */}
        <span aria-hidden="true" /><span className="chat-loading-label" key={workingLabel(entry.tools, Boolean(entry.content))}>{workingLabel(entry.tools, Boolean(entry.content))}</span>
      </p>}
    </MessageContent>
    {entry.ui && <GeneratedUI ui={entry.ui} />}
    {/* Steps and sources sit under the answer. The trace is open while the model works and folds away as
        the first words arrive, so the answer never streams above a wall of code. */}
    <EntryTrace entry={entry} />
    {!!entry.actions?.length && <ul className="chat-actions">
      {entry.actions.map(action => <li key={action.id} data-status={action.status ?? 'running'}>
        <Compass size={12} aria-hidden="true" />
        <span>{action.label}</span>
        <small>{action.status === 'missing' ? 'section not found' : action.status === 'failed' ? 'could not open' : action.status === 'done' ? 'opened' : 'opening…'}</small>
      </li>)}
    </ul>}
    {entry.images?.map(image => <figure className="chat-image" key={image.id}>
      <img src={image.src} alt={image.alt} loading="lazy" />
      <figcaption>{image.caption}</figcaption>
    </figure>)}
    <EntrySlots entry={entry} panel={panel} actions={actions} />
    <EntryProposals entry={entry} actions={actions} />
    {entry.artifacts?.map(artifact => {
      const diagram = artifact.kind === 'diagram' ? artifact.markdown?.match(/```mermaid\n([\s\S]*?)```/)?.[1] : undefined;
      return <article className="chat-artifact" key={artifact.id}>
        <p className="chat-artifact-head"><FileText size={13} aria-hidden="true" /> {artifact.kind} · {artifact.title}</p>
        {diagram && <Diagram source={diagram} title={artifact.title} />}
        <div className="chat-artifact-foot">
          {/* The document opens on its own surface; the chat keeps the summary, not the whole text. */}
          {artifact.markdown && <ArtifactView artifact={artifact} markdown={artifact.markdown} markdownOptions={MARKDOWN} onDownload={() => void download(artifact)} />}
          <Button type="button" variant="ghost" onClick={() => void download(artifact)}><Download size={13} aria-hidden="true" /> .md</Button>
          <small>{Math.max(1, Math.round(artifact.bytes / 1024))} KB · kept until {new Date(artifact.expiresAt).toLocaleDateString()}</small>
        </div>
      </article>;
    })}
    {entry.draft && <EntryDraft draft={entry.draft} actions={actions} />}
    {(entry.state === 'incomplete' || entry.error) && <p className="chat-incomplete" role="alert">{entry.error ?? 'Incomplete answer'}</p>}
    {entry.role === 'assistant' && entry.state !== 'streaming' && (() => {
      const again = retryOf(entry.id);
      const vote = entry.vote;
      return <MessageActions>
        {entry.content && <Button type="button" variant="ghost" title="Copy answer" onClick={() => void copy(entry)}>
          {copied === entry.id ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied === entry.id ? 'Copied' : 'Copy'}
        </Button>}
        {again && <Button type="button" variant="ghost" title="Ask again" disabled={busy} onClick={() => void ask(again.question, again.ids)}>
          <RotateCcw size={13} aria-hidden="true" /> Retry
        </Button>}
        {entry.content && <>
          <Button type="button" size="icon" variant="ghost" aria-label="Good answer" title="Good answer" aria-pressed={vote === 'up'}
            onClick={() => setEntries(previous => previous.map(item => item.id === entry.id ? { ...item, vote: item.vote === 'up' ? undefined : 'up' } : item))}>
            <ThumbsUp size={13} aria-hidden="true" />
          </Button>
          <Button type="button" size="icon" variant="ghost" aria-label="Bad answer" title="Bad answer" aria-pressed={vote === 'down'}
            onClick={() => setEntries(previous => previous.map(item => item.id === entry.id ? { ...item, vote: item.vote === 'down' ? undefined : 'down' } : item))}>
            <ThumbsDown size={13} aria-hidden="true" />
          </Button>
        </>}
      </MessageActions>;
    })()}
  </Message>;
}
