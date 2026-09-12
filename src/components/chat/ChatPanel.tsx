import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, CalendarClock, Check, Compass, Copy, Download, ExternalLink, FileText, ImagePlus, Mail, MessageSquare, RotateCcw, Send, Square, ThumbsDown, ThumbsUp, Trash2, X } from 'lucide-react';
import Diagram from './Diagram';
import { Button } from '../ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '../ui/sheet';
import { Message, MessageActions, MessageContent, MessageResponse, preloadResponse } from '../ai-elements/message';
import { artifactLink, clearMessages, confirmBooking, createSession, loadMessages, prepareAttachment, SessionExpired, proposeSlot, sendContact, streamAnswer, type Artifact, type Availability, type BookingProposal, type ContactDraft, type RequestedUiAction, type Slot, type SourceCitation, type Attachment, type ShownImage, type ToolActivity, type Usage } from '../../lib/chat-stream';
import { acknowledgeAction, runAction, type ActionStatus } from '../../lib/site-actions';

type Entry = {
  id: string; role: 'user' | 'assistant'; content: string;
  state?: 'streaming' | 'complete' | 'incomplete';
  tools?: ToolActivity[]; sources?: SourceCitation[];
  actions?: (RequestedUiAction & { status?: ActionStatus })[];
  draft?: ContactDraft & { state: 'editing' | 'sending' | 'sent' | 'failed'; error?: string };
  artifacts?: (Omit<Artifact, 'markdown'> & { markdown?: string })[];
  availability?: Availability[];
  proposals?: (BookingProposal & { state?: 'confirming' | 'confirmed' | 'failed'; error?: string })[];
  usage?: Usage;
  error?: string;
  images?: ShownImage[];
  attachment?: { dataUrl: string; name: string };
};

const slotLabel = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(iso));
const timeLabel = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(iso));
const dayKey = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(new Date(iso));
const dayLabel = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(new Date(iso));

// Slots arrive as one flat list; a picker is only usable grouped by the visitor's own day.
function groupByDay(slots: Slot[], timeZone: string) {
  const days = new Map<string, { key: string; label: string; slots: Slot[] }>();
  for (const slot of slots) {
    const key = dayKey(slot.start, timeZone);
    const day = days.get(key) ?? { key, label: dayLabel(slot.start, timeZone), slots: [] };
    day.slots.push(slot);
    days.set(key, day);
  }
  return [...days.values()];
}
const SESSION_KEY = 'assistant-session';
// localStorage keeps the token per browser. It throws in some privacy modes, so every access is guarded.
const readToken = () => { try { return localStorage.getItem(SESSION_KEY) ?? undefined; } catch { return undefined; } };
const writeToken = (token?: string) => { try { token ? localStorage.setItem(SESSION_KEY, token) : localStorage.removeItem(SESSION_KEY); } catch {} };
const starters = [
  { tag: '01 / Systems', question: 'What makes HyprFM interesting?' },
  { tag: '02 / AI engineering', question: 'Tell me about Jim’s AI engineering work.' },
  { tag: '03 / Match a role', question: 'I will paste a job description. Which requirements does Jim actually have evidence for?' },
];
// Good enough to catch a typo before a round trip; the server validates properly.
const validEmail = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
const MIN_WIDTH = 340;
const DEFAULT_WIDTH = 420;
const clampWidth = (value: number) => Math.round(Math.min(Math.max(value, MIN_WIDTH), Math.max(MIN_WIDTH, Math.min(760, window.innerWidth - 96))));

export default function ChatPanel({ endpoint }: { endpoint: string }) {
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  // Only failures the message list cannot show sit above the composer; progress stays in the live region.
  const [alert, setAlert] = useState('');
  const [votes, setVotes] = useState<Record<string, 'up' | 'down'>>({});
  const [copied, setCopied] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [openDays, setOpenDays] = useState<Record<string, string>>({});
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const token = useRef<string | undefined>(undefined);
  const hydrated = useRef(false);
  // Actions run exactly once: replaying a stored conversation must not navigate the visitor again.
  const performed = useRef(new Set<string>());
  const controller = useRef<AbortController | null>(null);
  const follow = useRef(true);
  // Id of the user message pinned to the top of the viewport for the current turn.
  const anchor = useRef('');
  const spacer = useRef<HTMLDivElement>(null);
  // True while the running turn owns the scroll position; any manual scroll hands it back.
  const pinned = useRef(false);

  useEffect(() => {
    const media = matchMedia('(max-width: 767px)');
    const update = () => setMobile(media.matches);
    const resize = () => setWidth(current => clampWidth(current));
    // Width is a per-viewer convenience. localStorage can throw in private windows.
    try { const saved = Number(localStorage.getItem('assistant-width')); if (saved) setWidth(clampWidth(saved)); } catch {}
    update(); media.addEventListener('change', update); addEventListener('resize', resize);
    return () => { media.removeEventListener('change', update); removeEventListener('resize', resize); controller.current?.abort(); };
  }, []);
  useEffect(() => {
    document.documentElement.style.setProperty('--assistant-width', `${width}px`);
    try { localStorage.setItem('assistant-width', String(width)); } catch {}
  }, [width]);
  // Any element on the site can open the panel with a question or a repository already chosen.
  // Re-registered every render on purpose, so the handler always calls the current ask().
  useEffect(() => {
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<{ question?: string; repo?: string; path?: string }>).detail ?? {};
      setOpen(true);
      if (detail.question) void ask(detail.question);
    };
    addEventListener('assistant:ask', onAsk);
    return () => removeEventListener('assistant:ask', onAsk);
  });

  useEffect(() => {
    if (!open) return;
    void preloadResponse();
    if (hydrated.current || !endpoint) return;
    hydrated.current = true;
    token.current = readToken();
    if (!token.current) return;
    // Restore the conversation this browser already owns; a dead token is simply dropped.
    void loadMessages(endpoint, token.current)
      .then(messages => setEntries(messages.map(message => ({
        id: crypto.randomUUID(), role: message.role, content: message.content, state: 'complete' as const,
        sources: message.sources, tools: message.tools.map((tool, index) => ({ id: `${index}`, name: tool.name, summary: tool.summary, status: 'done' as const, ms: tool.ms })),
        artifacts: message.artifacts, proposals: message.proposals, usage: message.usage, images: message.images,
        actions: message.actions.map(action => { performed.current.add(action.id); return { ...action, anchor: '', action: 'reveal' as const, status: 'done' as const }; }),
      }))))
      .catch(error => { if (error instanceof SessionExpired) { token.current = undefined; writeToken(); } else setAlert('Earlier messages could not be loaded.'); });
  }, [open, endpoint]);
  // The pinned turn needs empty room beneath it, or the scroller cannot lift it to the top.
  const fit = useCallback(() => {
    const box = viewport.current, pad = spacer.current;
    if (!box || !pad) return;
    const top = anchor.current && box.querySelector(`[data-entry="${anchor.current}"]`);
    const last = pad.previousElementSibling;
    if (!top || !last || last === pad) { pad.style.height = '0px'; return; }
    const turn = last.getBoundingClientRect().bottom - top.getBoundingClientRect().top;
    pad.style.height = `${Math.max(0, box.clientHeight - turn - 36)}px`;
  }, []);
  const toAnchor = useCallback((behavior: ScrollBehavior = 'auto') => {
    const box = viewport.current;
    const top = anchor.current && box?.querySelector(`[data-entry="${anchor.current}"]`);
    if (!box || !top) return;
    box.scrollTo({ top: box.scrollTop + top.getBoundingClientRect().top - box.getBoundingClientRect().top - 12, behavior });
  }, []);
  useEffect(() => {
    fit();
    // The spacer shrinks as the answer grows, so the pin is re-asserted until the visitor scrolls.
    if (pinned.current) toAnchor();
    else if (follow.current && viewport.current) viewport.current.scrollTop = entries.length ? viewport.current.scrollHeight : 0;
  }, [entries, open, fit, toAnchor]);

  const drag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('assistant-resizing');
    const move = (moved: PointerEvent) => setWidth(clampWidth(window.innerWidth - moved.clientX));
    const stop = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); handle.removeEventListener('pointercancel', stop);
      document.documentElement.classList.remove('assistant-resizing');
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', stop); handle.addEventListener('pointercancel', stop);
  }, []);

  const toBottom = () => {
    follow.current = true; setAtBottom(true);
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
  };

  // Any answer can be re-asked: the question is simply the user message before it.
  const retryOf = (id: string) => {
    const index = entries.findIndex(entry => entry.id === id);
    const asked = index > 0 ? entries[index - 1] : undefined;
    return asked?.role === 'user' ? { question: asked.content, ids: [asked.id, id] } : null;
  };

  async function session() {
    if (!token.current) { token.current = await createSession(endpoint); writeToken(token.current); }
    return token.current;
  }

  async function ask(value: string, replacing?: string[]) {
    const prompt = value.trim();
    if (controller.current || !prompt || prompt.length > 4000) return;
    if (!endpoint) { setAlert('Assistant is not connected yet. Use the contact button to reach Jim.'); return; }
    const userId = crypto.randomUUID(); const answerId = crypto.randomUUID();
    const sending = attachment;
    setEntries(previous => [...previous.filter(entry => !replacing?.includes(entry.id)),
      { id: userId, role: 'user', content: prompt, ...(sending ? { attachment: { dataUrl: sending.dataUrl, name: sending.name } } : {}) },
      { id: answerId, role: 'assistant', content: '', state: 'streaming' }]);
    setAttachment(null);
    const abort = new AbortController(); controller.current = abort;
    const timer = setTimeout(() => abort.abort('timeout'), 125000);
    setQuestion(''); setBusy(true); setAlert(''); setStatus('Connecting…');
    // The question rides to the top of the viewport and stays put: the answer grows below it.
    anchor.current = userId; follow.current = false; pinned.current = true; setAtBottom(false);
    requestAnimationFrame(() => { fit(); toAnchor('smooth'); });
    const patch = (change: (entry: Entry) => Entry) => setEntries(previous => previous.map(entry => entry.id === answerId ? change(entry) : entry));
    const handlers = {
      text: (text: string) => { setStatus('Receiving answer…'); patch(entry => ({ ...entry, content: text })); },
      tool: (activity: ToolActivity) => {
        setStatus(activity.status === 'running' ? `Reading source: ${activity.name.replace(/_/g, ' ')}…` : 'Receiving answer…');
        patch(entry => ({ ...entry, tools: [...(entry.tools ?? []).filter(previous => previous.id !== activity.id), activity] }));
      },
      sources: (sources: SourceCitation[]) => patch(entry => ({ ...entry, sources })),
      draft: (draft: ContactDraft) => patch(entry => ({ ...entry, draft: { ...draft, state: 'editing' } })),
      artifact: (artifact: Artifact) => patch(entry => ({ ...entry, artifacts: [...(entry.artifacts ?? []), artifact] })),
      slots: (availability: Availability) => patch(entry => ({
        ...entry,
        availability: [...(entry.availability ?? []).filter(existing => existing.key !== availability.key), availability],
      })),
      proposal: (proposal: BookingProposal) => patch(entry => ({ ...entry, proposals: [...(entry.proposals ?? []), proposal] })),
      usage: (usage: Usage) => patch(entry => ({ ...entry, usage })),
      image: (image: ShownImage) => patch(entry => ({ ...entry, images: [...(entry.images ?? []), image] })),
      action: (request: RequestedUiAction) => {
        patch(entry => ({ ...entry, actions: [...(entry.actions ?? []), request] }));
        if (performed.current.has(request.id)) return;
        performed.current.add(request.id);
        // Runs alongside the stream: the page moves while the answer keeps arriving.
        void runAction(request, abort.signal)
          .catch(() => 'failed' as ActionStatus)
          .then(status => {
            patch(entry => ({ ...entry, actions: (entry.actions ?? []).map(existing => existing.id === request.id ? { ...existing, status } : existing) }));
            if (token.current) void acknowledgeAction(endpoint, token.current, request.id, status);
          });
      },
    };
    try {
      // The server owns the history, so an expired session is replaced and the question resent once.
      let result;
      try { result = await streamAnswer(endpoint, await session(), prompt, abort.signal, handlers, sending ?? undefined); }
      catch (error) {
        if (!(error instanceof SessionExpired)) throw error;
        token.current = undefined; writeToken();
        result = await streamAnswer(endpoint, await session(), prompt, abort.signal, handlers, sending ?? undefined);
      }
      setEntries(previous => previous.map(entry => entry.id === answerId ? { ...entry, content: result.text, state: 'complete' } : entry));
      setStatus(result.finishReason === 'length' ? 'Length limit reached. Ask a follow-up to continue.' : 'Answer complete.');
    } catch (error) {
      const reason = abort.signal.aborted ? (abort.signal.reason === 'timeout' ? 'Response timed out. Retry when ready.' : 'Stopped. You can retry this question.') : error instanceof Error ? error.message : 'Could not connect to the assistant.';
      setStatus(reason);
      setEntries(previous => previous.map(entry => entry.id === answerId ? { ...entry, state: 'incomplete', error: reason } : entry));
    } finally { clearTimeout(timer); controller.current = null; pinned.current = false; setBusy(false); }
  }

  const editDraft = (id: string, change: Partial<Entry['draft']>) =>
    setEntries(previous => previous.map(entry => entry.draft?.id === id ? { ...entry, draft: { ...entry.draft, ...change } as Entry['draft'] } : entry));

  async function submitDraft(draft: NonNullable<Entry['draft']>) {
    if (draft.state === 'sending' || draft.state === 'sent') return;
    if (!draft.name.trim() || !validEmail(draft.email) || draft.message.trim().length < 10) {
      editDraft(draft.id, { error: 'Add your name, a valid email and a few more words.' });
      return;
    }
    editDraft(draft.id, { state: 'sending', error: undefined });
    try {
      // The draft id makes a retry idempotent: the same draft is never delivered twice.
      const result = await sendContact(endpoint, token.current, { draftId: draft.id, name: draft.name.trim(), email: draft.email.trim(), message: draft.message.trim() });
      editDraft(draft.id, { state: 'sent' });
      setStatus(result.status === 'already-sent' ? 'That message was already sent.' : `Sent to ${draft.to}.`);
    } catch (error) {
      editDraft(draft.id, { state: 'failed', error: error instanceof Error ? error.message : 'The message could not be sent.' });
    }
  }

  const editProposal = (id: string, change: Partial<NonNullable<Entry['proposals']>[number]>) =>
    setEntries(previous => previous.map(entry => ({
      ...entry,
      proposals: entry.proposals?.map(proposal => proposal.id === id ? { ...proposal, ...change } : proposal),
    })));

  async function confirm(proposal: NonNullable<Entry['proposals']>[number]) {
    if (!token.current || proposal.state === 'confirming' || proposal.state === 'confirmed') return;
    if (!proposal.name.trim() || !validEmail(proposal.email)) {
      editProposal(proposal.id, { error: 'Add your name and a valid email.' });
      return;
    }
    editProposal(proposal.id, { state: 'confirming', error: undefined });
    try {
      const result = await confirmBooking(endpoint, token.current, {
        proposalId: proposal.id, start: proposal.start, name: proposal.name.trim(), email: proposal.email.trim(), timeZone: proposal.timeZone,
      });
      editProposal(proposal.id, { state: 'confirmed' });
      setStatus(result.status === 'already-booked' ? 'That call was already booked.' : `Booked for ${slotLabel(result.start, proposal.timeZone)}.`);
    } catch (error) {
      // A taken slot comes back with the current ones, so the visitor can pick again immediately.
      const slots = (error as { slots?: Slot[] }).slots;
      if (slots?.length) replaceSlots(proposal, slots);
      editProposal(proposal.id, { state: 'failed', error: error instanceof Error ? error.message : 'The call could not be booked.' });
    }
  }

  // Picking a time is the whole booking flow: hold the slot, then show the confirmation card.
  async function chooseSlot(entryId: string, availability: Availability, slot: Slot) {
    const existing = entries.find(entry => entry.id === entryId)?.proposals?.find(proposal => proposal.key === availability.key && proposal.state !== 'confirmed');
    if (existing) { editProposal(existing.id, { start: slot.start, end: slot.end, state: undefined, error: undefined }); return; }
    if (!token.current) return;
    setStatus('Holding that time…');
    try {
      const proposal = await proposeSlot(endpoint, token.current, { start: slot.start, key: availability.key, timeZone: availability.timeZone });
      setEntries(previous => previous.map(entry => entry.id === entryId ? { ...entry, proposals: [...(entry.proposals ?? []), proposal] } : entry));
      setStatus('Check the details and confirm.');
    } catch (error) {
      const slots = (error as { slots?: Slot[] }).slots;
      if (slots?.length) {
        setEntries(previous => previous.map(entry => entry.id === entryId
          ? { ...entry, availability: [...(entry.availability ?? []).filter(other => other.key !== availability.key), { ...availability, slots }] }
          : entry));
      }
      setAlert(error instanceof Error ? error.message : 'That time could not be held.');
    }
  }

  // A conflict returns the live slots for that meeting, so the picker is replaced in place.
  const replaceSlots = (proposal: BookingProposal, slots: Slot[]) =>
    setEntries(previous => previous.map(entry => entry.proposals?.some(existing => existing.id === proposal.id)
      ? {
          ...entry,
          availability: [
            ...(entry.availability ?? []).filter(existing => existing.key !== proposal.key),
            { timeZone: proposal.timeZone, durationMinutes: proposal.durationMinutes, label: proposal.label, key: proposal.key, slots },
          ],
        }
      : entry));

  async function download(artifact: { id: string; title: string }) {
    if (!token.current) return;
    setStatus('Preparing the download…');
    try {
      const link = await artifactLink(endpoint, token.current, artifact.id);
      // A signed link, opened by the visitor: the file is never proxied through this page.
      window.open(link.url, '_blank', 'noopener,noreferrer');
      setStatus(`Download link opened. It expires in ${link.expiresInSeconds} seconds.`);
    } catch (error) {
      setAlert(error instanceof SessionExpired ? 'That document belonged to an older session.' : error instanceof Error ? error.message : 'The download could not be prepared.');
    }
  }

  async function attach(file: File | null | undefined) {
    if (!file) return;
    setStatus('Preparing the image…');
    try { setAttachment(await prepareAttachment(file)); setStatus('Image ready. Add a question and send.'); }
    catch (error) { setAlert(error instanceof Error ? error.message : 'That image could not be attached.'); }
  }

  async function copy(entry: Entry) {
    try { await navigator.clipboard.writeText(entry.content); setCopied(entry.id); setStatus('Answer copied.'); }
    catch { setAlert('Could not copy. Select the answer text to copy it manually.'); }
  }

  return <div className="assistant-root" ref={setPortal}>
    <Sheet open={open} onOpenChange={setOpen} modal={mobile}>
      <SheetTrigger asChild>
        <Button className="assistant-launch" variant="default" hidden={open} disabled={!portal}>
          <MessageSquare size={16} aria-hidden="true" /> Ask about my work
        </Button>
      </SheetTrigger>
      <SheetContent container={portal}
        onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); }}
        onInteractOutside={event => { if (!mobile) event.preventDefault(); }}>
        {!mobile && <div className="assistant-resizer" role="separator" aria-orientation="vertical" aria-label="Resize assistant panel"
          aria-valuenow={width} aria-valuemin={MIN_WIDTH} aria-valuemax={760} tabIndex={0} onPointerDown={drag}
          onDoubleClick={() => setWidth(clampWidth(DEFAULT_WIDTH))}
          onKeyDown={event => {
            const step = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0;
            if (step) { event.preventDefault(); setWidth(current => clampWidth(current + step)); }
          }} />}
        <header className="assistant-header">
          <SheetTitle className="assistant-title">SPJ <span aria-hidden="true">/</span> Assistant</SheetTitle>
          <div className="assistant-header-actions">
            <Button size="icon" variant="ghost" aria-label="Clear chat" title="Clear chat" disabled={busy || !entries.length} onClick={() => {
              setEntries([]); setQuestion(''); setCopied(''); setVotes({}); setAlert(''); setStatus('Chat cleared.'); setAtBottom(true); follow.current = true; pinned.current = false; anchor.current = ''; input.current?.focus();
              if (token.current) void clearMessages(endpoint, token.current).catch(error => { if (error instanceof SessionExpired) { token.current = undefined; writeToken(); } });
            }}><Trash2 size={15} aria-hidden="true" /></Button>
            <SheetClose asChild><Button size="icon" variant="ghost" aria-label="Close assistant"><X size={17} aria-hidden="true" /></Button></SheetClose>
          </div>
        </header>
        <SheetDescription className="assistant-sr-only">Ask about Jim’s projects, engineering work and research. Answers come from public portfolio content.</SheetDescription>
        <div className="assistant-body" ref={viewport}
          onWheel={() => { pinned.current = false; }} onTouchMove={() => { pinned.current = false; }}
          onScroll={() => {
          // While a turn is running the pinned question owns the scroll position; scrolling must not re-arm follow.
          if (busy) return;
          const el = viewport.current!; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; setAtBottom(follow.current);
        }}>
          {!entries.length && <div className="assistant-empty">
            <h3>Ask about the work.</h3>
            <p>It reads the source of Jim's repositories before answering, shows the lines it read, and can take you to a page, draft a message or find a time to talk.</p>
            <div className="assistant-prompts">{starters.map(({ tag, question: starter }) =>
              <Button key={tag} onClick={() => void ask(starter)}><span><small>{tag}</small>{starter}</span><ArrowRight size={15} aria-hidden="true" /></Button>
            )}</div>
          </div>}
          <div className="assistant-messages" role="log" aria-label="Conversation" aria-live="off" aria-busy={busy}>
            {entries.map(entry => <Message key={entry.id} from={entry.role} data-entry={entry.id}>
              <div className="chat-message-label"><span>{entry.role === 'user' ? 'You' : 'Assistant'}</span>{entry.state === 'streaming' && <span className="chat-live-label">Responding</span>}</div>
              <MessageContent>
                {entry.role === 'user' ? <>
                  {entry.attachment && <img className="chat-attachment" src={entry.attachment.dataUrl} alt={`Attached ${entry.attachment.name}`} />}
                  <p className="chat-user-text">{entry.content}</p>
                </> : entry.content ?
                  <MessageResponse isAnimating={entry.state === 'streaming'} skipHtml disallowedElements={['img']} linkSafety={{ enabled: false }} controls={{ code: { copy: true, download: false }, table: false }}>
                    {entry.content}
                  </MessageResponse> : entry.state === 'streaming' ? <div className="chat-loading" aria-label="Waiting for the model"><span /><span /><span /></div> : <p>No answer received.</p>}
              </MessageContent>
              {(!!entry.tools?.length || !!entry.sources?.length || entry.usage) && <details className="chat-trace" open={entry.state === 'streaming'}>
                <summary>
                  <span className="chat-trace-facts">
                    {!!entry.tools?.length && `${entry.tools.length} ${entry.tools.length === 1 ? 'step' : 'steps'}`}
                    {!!entry.sources?.length && `${entry.tools?.length ? ' · ' : ''}${entry.sources.length} ${entry.sources.length === 1 ? 'source' : 'sources'}`}
                    {entry.usage && `${entry.tools?.length || entry.sources?.length ? ' · ' : ''}${(entry.usage.ms / 1000).toFixed(1)}s`}
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
                  {entry.sources.map(source => <article key={`${source.repo}:${source.path}:${source.startLine}-${source.endLine}`}>
                    <a className="chat-source-open" href={source.url} target="_blank" rel="noopener noreferrer">
                      {source.repo}/{source.path}:{source.startLine}-{source.endLine}
                      <ExternalLink size={11} aria-hidden="true" />
                    </a>
                    <span className="chat-source-meta">@ {source.commit.slice(0, 8)}{source.symbols.length ? ` · ${source.symbols.slice(0, 4).join(', ')}` : ''}</span>
                    <MessageResponse skipHtml disallowedElements={['img']} linkSafety={{ enabled: false }}
                      codeBlockMaxHeight={260} controls={{ code: { copy: true, download: false }, table: false }}>
                      {`\`\`\`${source.language || 'text'}\n${source.snippet}\n\`\`\``}
                    </MessageResponse>
                  </article>)}
                </div>}
              </details>}
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
              {entry.availability?.map(availability => {
                const days = groupByDay(availability.slots, availability.timeZone);
                const chosen = entry.proposals?.find(proposal => proposal.key === availability.key)?.start;
                const openDay = openDays[availability.key] ?? (chosen ? dayKey(chosen, availability.timeZone) : days[0]?.key);
                const day = days.find(candidate => candidate.key === openDay) ?? days[0];
                return <div className="chat-slots" key={availability.key}>
                  <p className="chat-slots-head"><CalendarClock size={13} aria-hidden="true" /> {availability.label} · {availability.durationMinutes} min · {availability.timeZone}</p>
                  {days.length ? <>
                    <div className="chat-day-list" role="tablist" aria-label={`Days with ${availability.label} availability`}>
                      {days.map(candidate => <button key={candidate.key} type="button" role="tab"
                        aria-selected={candidate.key === day.key}
                        onClick={() => setOpenDays(previous => ({ ...previous, [availability.key]: candidate.key }))}>
                        <span>{candidate.label}</span><small>{candidate.slots.length} free</small>
                      </button>)}
                    </div>
                    <div className="chat-slot-list" role="tabpanel">{day.slots.map(slot =>
                      <Button key={slot.start} type="button" aria-pressed={chosen === slot.start}
                        onClick={() => void chooseSlot(entry.id, availability, slot)}>{timeLabel(slot.start, availability.timeZone)}</Button>)}
                    </div>
                    {!entry.proposals?.some(proposal => proposal.key === availability.key) && <p className="chat-slots-hint">Pick a time to review and confirm it.</p>}
                  </> : <p className="chat-slots-empty">No free times for this length in the booking window.</p>}
                </div>;
              })}
              {entry.proposals?.map(proposal => { const locked = proposal.state === 'confirming' || proposal.state === 'confirmed';
                return <form className="chat-booking" key={proposal.id} noValidate data-state={proposal.state ?? 'editing'}
                onSubmit={event => { event.preventDefault(); void confirm(proposal); }}>
                <p className="chat-booking-head"><CalendarClock size={13} aria-hidden="true" /> Confirm · {proposal.label} · {proposal.durationMinutes} min</p>
                <p className="chat-booking-when">{slotLabel(proposal.start, proposal.timeZone)} <small>{proposal.timeZone}</small></p>
                <label>Your name
                  <input value={proposal.name} maxLength={120} readOnly={locked}
                    onChange={event => editProposal(proposal.id, { name: event.target.value })} />
                </label>
                <label>Your email
                  <input type="email" value={proposal.email} maxLength={200} readOnly={locked}
                    onChange={event => editProposal(proposal.id, { email: event.target.value })} />
                </label>
                {proposal.notes && <p className="chat-booking-notes">{proposal.notes}</p>}
                {proposal.state === 'confirmed'
                  ? <p className="chat-booking-done"><Check size={13} aria-hidden="true" /> Booked. The invitation is on its way to {proposal.email}.</p>
                  : <Button type="submit" variant="default" disabled={proposal.state === 'confirming'}>
                      <CalendarClock size={14} aria-hidden="true" /> {proposal.state === 'confirming' ? 'Booking…' : proposal.state === 'failed' ? 'Try again' : 'Confirm this time'}
                    </Button>}
                <p className="chat-booking-note" role="status">{proposal.error ?? (proposal.state === 'confirmed' ? '' : 'Check the time and your details. Nothing is booked until you confirm.')}</p>
              </form>;
              })}
              {entry.artifacts?.map(artifact => {
                const diagram = artifact.markdown?.match(/```mermaid\n([\s\S]*?)```/)?.[1];
                return <article className="chat-artifact" key={artifact.id}>
                  <p className="chat-artifact-head"><FileText size={13} aria-hidden="true" /> {artifact.kind} · {artifact.title}</p>
                  {diagram && <Diagram source={diagram} title={artifact.title} />}
                  {artifact.markdown && <details className="chat-artifact-preview">
                    <summary>Preview the document</summary>
                    <MessageResponse skipHtml disallowedElements={['img']} linkSafety={{ enabled: false }} controls={{ code: { copy: true, download: false }, table: false }}>
                      {artifact.markdown}
                    </MessageResponse>
                  </details>}
                  <div className="chat-artifact-foot">
                    <Button type="button" onClick={() => void download(artifact)}><Download size={13} aria-hidden="true" /> Download</Button>
                    <small>{Math.max(1, Math.round(artifact.bytes / 1024))} KB · kept until {new Date(artifact.expiresAt).toLocaleDateString()}</small>
                  </div>
                </article>;
              })}
              {entry.draft && (() => { const draft = entry.draft; const locked = draft.state !== 'editing' && draft.state !== 'failed';
                return <form className="chat-draft" noValidate data-state={draft.state} onSubmit={event => { event.preventDefault(); void submitDraft(draft); }}>
                <p className="chat-draft-head"><Mail size={13} aria-hidden="true" /> Message to {draft.to}</p>
                <label>Your name
                  <input value={draft.name} maxLength={120} readOnly={locked}
                    onChange={event => editDraft(draft.id, { name: event.target.value })} />
                </label>
                <label>Your email
                  <input type="email" value={draft.email} maxLength={200} readOnly={locked}
                    onChange={event => editDraft(draft.id, { email: event.target.value })} />
                </label>
                <label>Message
                  <textarea rows={5} value={draft.message} maxLength={4000} readOnly={locked}
                    onChange={event => editDraft(draft.id, { message: event.target.value })} />
                </label>
                {draft.state === 'sent'
                  ? <p className="chat-draft-sent"><Check size={13} aria-hidden="true" /> Handed to the mail provider. {draft.to} will see it shortly.</p>
                  : <Button type="submit" variant="default" disabled={draft.state === 'sending'}>
                      <Send size={14} aria-hidden="true" /> {draft.state === 'sending' ? 'Sending…' : draft.state === 'failed' ? 'Try again' : 'Send message'}
                    </Button>}
                <p className="chat-draft-note" role="status">{draft.error ?? (draft.state === 'sent' ? '' : 'Edit anything above. Nothing is sent until you press Send.')}</p>
              </form>;
              })()}
              {entry.state === 'incomplete' && <p className="chat-incomplete" role="alert">{entry.error ?? 'Incomplete answer'}</p>}
              {entry.role === 'assistant' && entry.state !== 'streaming' && (() => {
                const again = retryOf(entry.id);
                const vote = votes[entry.id];
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
                      onClick={() => setVotes(current => ({ ...current, [entry.id]: current[entry.id] === 'up' ? undefined : 'up' } as typeof current))}>
                      <ThumbsUp size={13} aria-hidden="true" />
                    </Button>
                    <Button type="button" size="icon" variant="ghost" aria-label="Bad answer" title="Bad answer" aria-pressed={vote === 'down'}
                      onClick={() => setVotes(current => ({ ...current, [entry.id]: current[entry.id] === 'down' ? undefined : 'down' } as typeof current))}>
                      <ThumbsDown size={13} aria-hidden="true" />
                    </Button>
                  </>}
                </MessageActions>;
              })()}
            </Message>)}
            <div className="chat-tailspace" ref={spacer} aria-hidden="true" />
          </div>
        </div>
        {!atBottom && !busy && <Button className="assistant-jump" onClick={toBottom}><ArrowDown size={14} aria-hidden="true" /> Latest</Button>}
        <footer className="assistant-footer">
          {alert && <p className="assistant-alert" role="alert">{alert}</p>}
          {attachment && <div className="assistant-attachment">
            <img src={attachment.dataUrl} alt={`Attached ${attachment.name}`} />
            <span>{attachment.name}</span>
            <Button type="button" size="icon" variant="ghost" aria-label="Remove the attached image" onClick={() => setAttachment(null)}><X size={14} aria-hidden="true" /></Button>
          </div>}
          <form className="assistant-form" onSubmit={event => { event.preventDefault(); void ask(question); }}
            onDragOver={event => event.preventDefault()}
            onDrop={event => { event.preventDefault(); void attach(event.dataTransfer.files?.[0]); }}>
            <label htmlFor="assistant-question" className="assistant-sr-only">Your question</label>
            <textarea id="assistant-question" ref={input} value={question} onChange={event => setQuestion(event.target.value)} maxLength={4000} rows={1} required
              placeholder="Ask about a project, a decision, a detail…" aria-describedby="assistant-privacy" readOnly={busy}
              onPaste={event => { const file = [...event.clipboardData.items].find(item => item.type.startsWith('image/'))?.getAsFile(); if (file) { event.preventDefault(); void attach(file); } }}
              onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) void ask(question); } }} />
            <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden
              onChange={event => { void attach(event.target.files?.[0]); event.target.value = ''; }} />
            <Button type="button" size="icon" variant="ghost" aria-label="Attach an image" title="Attach an image"
              disabled={busy} onClick={() => picker.current?.click()}><ImagePlus size={16} aria-hidden="true" /></Button>
            {busy ? <Button type="button" size="icon" aria-label="Stop response" title="Stop response" onClick={() => controller.current?.abort()}><Square size={14} aria-hidden="true" /></Button> :
              <Button type="submit" variant="default" size="icon" aria-label="Send message" title="Send message" disabled={!question.trim()}><ArrowUp size={16} aria-hidden="true" /></Button>}
          </form>
          <p className="assistant-sr-only" role="status" aria-live="polite">{status}</p>
          <p id="assistant-privacy" className="assistant-sr-only">Enter sends, Shift + Enter adds a line.</p>
        </footer>
      </SheetContent>
    </Sheet>
  </div>;
}
