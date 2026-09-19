import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, AudioLines, CalendarClock, Check, Compass, Copy, Download, ExternalLink, FileText, Mail, MessageSquare, Mic, RotateCcw, Send, Square, ThumbsDown, ThumbsUp, Trash2, X } from 'lucide-react';
import Diagram from './Diagram';
import ArtifactView from './ArtifactView';
import { Button } from '../ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '../ui/sheet';
import { Message, MessageActions, MessageContent, MessageResponse, preloadResponse } from '../ai-elements/message';
import { artifactLink, confirmBooking, createSession, SessionExpired, proposeSlot, sendContact, streamAnswer, transcribeAudio, type Artifact, type Availability, type BookingProposal, type ContactDraft, type RequestedUiAction, type Slot, type SourceCitation, type ShownImage, type ToolActivity, type Usage, type ChatMessage } from '../../lib/chat-stream';
import { clearConversation, loadConversation, saveConversation } from '../../lib/chat-history';
import { workingLabel } from '../../lib/chat-progress';
import { acknowledgeAction, runAction, type ActionStatus } from '../../lib/site-actions';
import { preloadTurnstile, turnstileToken } from '../../lib/turnstile';
import { starters } from '../../data/assistant-questions';

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
  vote?: 'up' | 'down';
  images?: ShownImage[];
  // A voice note keeps its recording and its transcript together; the transcript is what was sent.
  audio?: { blob: Blob; mediaType: string; seconds: number; transcript: string; model: string };
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
// Good enough to catch a typo before a round trip; the server validates properly.
const validEmail = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
// Mirrors the server's defaults (MAX_MESSAGES_PER_SESSION, MAX_CONTEXT_CHARS); it trims again either way.
const HISTORY_TURNS = 40;
const HISTORY_CHARS = 24000;
// Shared by reference: MessageResponse is memoised, and fresh object literals on every render would
// re-parse every earlier answer each time a streamed chunk arrives.
const MARKDOWN = { skipHtml: true, disallowedElements: ['img'], linkSafety: { enabled: false }, controls: { code: { copy: true, download: false }, table: false, mermaid: { download: true, copy: false, fullscreen: true, panZoom: true } } } as const;
// Silence, not total length, ends a turn: a long answer keeps streaming as long as events keep arriving.
const IDLE_TIMEOUT_MS = 90000;
const MIN_WIDTH = 340;

// Folded content is only rendered once opened: a collapsed source or preview costs nothing,
// where rendering it hidden would highlight every snippet the model read.
function Fold({ className, summary, children }: { className: string; summary: React.ReactNode; children: () => React.ReactNode }) {
  const [opened, setOpened] = useState(false);
  return <details className={className} onToggle={event => { if (event.currentTarget.open) setOpened(true); }}>
    <summary>{summary}</summary>
    {opened && children()}
  </details>;
}
// How much of the scroller the floating header covers, which is scroll-padding-top where it floats.
const headRoom = (box: HTMLElement) => parseFloat(getComputedStyle(box).scrollPaddingTop) || 0;
const DEFAULT_WIDTH = 420;
// Spelled-out codecs: Chrome claims plain audio/mp4 and then records opus in it, which nothing plays.
const VOICE_MIME_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
const MAX_TAKE_SECONDS = 120;
// A blob URL per audio bubble, created once and revoked when the entry goes away.
function AudioBubble({ audio }: { audio: NonNullable<Entry['audio']> }) {
  const [url, setUrl] = useState('');
  useEffect(() => { const next = URL.createObjectURL(audio.blob); setUrl(next); return () => URL.revokeObjectURL(next); }, [audio.blob]);
  return <div className="chat-audio">
    <AudioLines size={14} aria-hidden="true" />
    {url && <audio controls preload="metadata" src={url} aria-label={`Voice note, ${audio.seconds} seconds`} />}
    <span className="chat-audio-length">{Math.floor(audio.seconds / 60)}:{String(audio.seconds % 60).padStart(2, '0')}</span>
  </div>;
}
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
  const [copied, setCopied] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [openDays, setOpenDays] = useState<Record<string, string>>({});
  // A finished take waits in the footer until the visitor sends or discards it.
  const [take, setTake] = useState<{ blob: Blob; seconds: number } | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  // stop() is the only way out of a recording, so discard is a flag its handler reads.
  const discard = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const token = useRef<string | undefined>(undefined);
  const challengeSlot = useRef<HTMLDivElement>(null);
  // Saving waits for the stored conversation to load, so an empty first render never overwrites it.
  const loaded = useRef(false);
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
    // The width lives in an inline style on <html>, and a page swap replaces <html>'s attributes with
    // the incoming page's. Re-applying after the swap was too late: the view transition snapshots the
    // new page in between, laid out at the default width, so the sheet animated to the wrong size and
    // snapped back. Writing it onto the incoming document first means it is never missing.
    const value = `${width}px`;
    document.documentElement.style.setProperty('--assistant-width', value);
    try { localStorage.setItem('assistant-width', String(width)); } catch {}
    const carry = (event: Event) => (event as Event & { newDocument: Document }).newDocument.documentElement.style.setProperty('--assistant-width', value);
    document.addEventListener('astro:before-swap', carry);
    return () => document.removeEventListener('astro:before-swap', carry);
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

  // The slide belongs to the moment the panel opens or closes, not to the state it rests in. Astro
  // re-inserts the persisted panel on every page swap, and a CSS animation keyed on a resting
  // state restarts with each insertion. The phase exists only while the slide plays.
  const [phase, setPhase] = useState<'entering' | 'leaving'>();
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    if (open) void preloadResponse();
    setPhase(open ? 'entering' : 'leaving');
    const timer = setTimeout(() => setPhase(undefined), 320);
    return () => clearTimeout(timer);
  }, [open]);
  // The conversation is read from this browser at mount, so opening the panel never waits on the network.
  useEffect(() => {
    token.current = readToken();
    void loadConversation<Entry>()
      .then(saved => { if (saved.length) void preloadResponse(); return saved; })
      .then(saved => setEntries(current => current.length ? current : saved.map(entry => {
        // A replayed action has already moved the page once; an interrupted turn cannot resume.
        entry.actions?.forEach(action => performed.current.add(action.id));
        return {
          ...entry,
          state: entry.state === 'streaming' ? 'incomplete' : entry.state,
          draft: entry.draft?.state === 'sending' ? { ...entry.draft, state: 'editing' } : entry.draft,
          proposals: entry.proposals?.map(proposal => proposal.state === 'confirming' ? { ...proposal, state: undefined } : proposal),
        };
      })))
      .catch(() => {})
      .finally(() => { loaded.current = true; });
  }, []);
  // Written once a turn settles rather than on every streamed token.
  useEffect(() => {
    if (!loaded.current || entries.some(entry => entry.state === 'streaming')) return;
    void (entries.length ? saveConversation(entries) : clearConversation()).catch(() => {});
  }, [entries]);
  // The pinned turn needs empty room beneath it, or the scroller cannot lift it to the top.
  const fit = useCallback(() => {
    const box = viewport.current, pad = spacer.current;
    if (!box || !pad) return;
    const top = anchor.current && box.querySelector(`[data-entry="${anchor.current}"]`);
    const last = pad.previousElementSibling;
    if (!top || !last || last === pad) { pad.style.height = '0px'; return; }
    const turn = last.getBoundingClientRect().bottom - top.getBoundingClientRect().top;
    // On mobile the header floats over the list, so the room it covers is not room the turn can use.
    pad.style.height = `${Math.max(0, box.clientHeight - turn - 36 - headRoom(box))}px`;
  }, []);
  const toAnchor = useCallback((behavior: ScrollBehavior = 'auto') => {
    const box = viewport.current;
    const top = anchor.current && box?.querySelector(`[data-entry="${anchor.current}"]`);
    if (!box || !top) return;
    box.scrollTo({ top: box.scrollTop + top.getBoundingClientRect().top - box.getBoundingClientRect().top - 12 - headRoom(box), behavior });
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

  // One session start at a time: the panel begins one when it opens, and a question asked before it
  // finishes waits for that same start instead of running a second bot check.
  const startingSession = useRef<Promise<string> | null>(null);
  function session() {
    if (token.current) return Promise.resolve(token.current);
    startingSession.current ??= (async () => {
      const started = await createSession(endpoint, await turnstileToken(challengeSlot.current, 'session'));
      token.current = started;
      writeToken(started);
      return started;
    })().finally(() => { startingSession.current = null; });
    return startingSession.current;
  }
  // The bot check and session creation take a few seconds on a first visit. Starting them when the
  // panel opens hides that behind the moment the visitor spends reading the starters. A failure here
  // stays silent: the first question starts over and reports it.
  useEffect(() => {
    if (open && endpoint && !token.current) void session().catch(() => {});
  }, [open]);

  async function ask(value: string, replacing?: string[], audio?: Entry['audio']) {
    const prompt = value.trim();
    if (controller.current || !prompt || prompt.length > 4000) return;
    if (!endpoint) { setAlert('Assistant is not connected yet. Use the contact button to reach Jim.'); return; }
    // Finished exchanges become the model's context, newest last, within the server's character budget.
    // A picture is sent once, with its own question; later turns carry a note in its place.
    const history: ChatMessage[] = entries.flatMap((entry, index) => {
      const answer = entries[index + 1];
      if (entry.role !== 'user' || answer?.role !== 'assistant' || answer.state !== 'complete' || replacing?.includes(entry.id)) return [];
      return [
        { role: 'user' as const, content: entry.content },
        { role: 'assistant' as const, content: answer.content },
      ];
    }).slice(-HISTORY_TURNS);
    while (history.length && history.reduce((sum, turn) => sum + turn.content.length, prompt.length) > HISTORY_CHARS) history.splice(0, 2);
    const userId = crypto.randomUUID(); const answerId = crypto.randomUUID();
    setEntries(previous => [...previous.filter(entry => !replacing?.includes(entry.id)),
      { id: userId, role: 'user', content: prompt, ...(audio ? { audio } : {}) },
      { id: answerId, role: 'assistant', content: '', state: 'streaming' }]);
    const abort = new AbortController(); controller.current = abort;
    let timer = setTimeout(() => abort.abort('timeout'), IDLE_TIMEOUT_MS);
    const alive = () => { clearTimeout(timer); timer = setTimeout(() => abort.abort('timeout'), IDLE_TIMEOUT_MS); };
    // A fast model sends many chunks a frame; the answer is re-rendered at most once per frame with the latest text.
    let latest = '';
    let frame = 0;
    setQuestion(''); setBusy(true); setAlert(''); setStatus('Connecting…');
    // The question rides to the top of the viewport and stays put: the answer grows below it.
    anchor.current = userId; follow.current = false; pinned.current = true; setAtBottom(false);
    requestAnimationFrame(() => { fit(); toAnchor('smooth'); });
    const patch = (change: (entry: Entry) => Entry) => setEntries(previous => previous.map(entry => entry.id === answerId ? change(entry) : entry));
    const handlers = {
      text: (text: string) => {
        latest = text;
        frame ||= requestAnimationFrame(() => { frame = 0; setStatus('Receiving answer…'); patch(entry => ({ ...entry, content: latest })); });
      },
      tool: (activity: ToolActivity) => {
        setStatus(workingLabel([activity], Boolean(latest)));
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
    // Every event proves the turn is alive, so each one pushes the idle timeout back.
    const watched = Object.fromEntries(Object.entries(handlers).map(([name, handle]) =>
      [name, (value: never) => { alive(); (handle as (value: never) => void)(value); }])) as typeof handlers;
    try {
      // An expired session is replaced and the question resent once.
      let result;
      try { result = await streamAnswer(endpoint, await session(), prompt, history, abort.signal, watched); }
      catch (error) {
        if (!(error instanceof SessionExpired)) throw error;
        token.current = undefined; writeToken();
        result = await streamAnswer(endpoint, await session(), prompt, history, abort.signal, watched);
      }
      const cut = result.finishReason === 'length' ? 'Length limit reached. Ask a follow-up to continue.' : undefined;
      setEntries(previous => previous.map(entry => entry.id === answerId ? { ...entry, content: result.text, state: 'complete', error: cut } : entry));
      setStatus(cut ?? 'Answer complete.');
    } catch (error) {
      const reason = abort.signal.aborted ? (abort.signal.reason === 'timeout' ? 'Response timed out. Retry when ready.' : 'Stopped. You can retry this question.') : error instanceof Error ? error.message : 'Could not connect to the assistant.';
      setStatus(reason);
      setEntries(previous => previous.map(entry => entry.id === answerId ? { ...entry, state: 'incomplete', error: reason } : entry));
    } finally { clearTimeout(timer); cancelAnimationFrame(frame); controller.current = null; pinned.current = false; setBusy(false); }
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

  async function startRecording() {
    setAlert('');
    // The mic only exists on a secure origin; over plain http the API is simply absent.
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setAlert('Voice notes need a secure (https) connection and a browser with microphone support.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = VOICE_MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      const startedAt = Date.now();
      discard.current = false;
      rec.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data); };
      rec.onstop = () => {
        // Releasing the tracks is what turns the browser's recording indicator off.
        stream.getTracks().forEach(track => track.stop());
        recorder.current = null; setRecording(false); setSeconds(0);
        if (discard.current) return;
        const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' });
        const length = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        // A container the browser claimed to support can still mux nothing.
        if (blob.size < 1000) { setAlert('That take came out empty. Try again.'); return; }
        setTake({ blob, seconds: length });
        setStatus(`Recorded ${length} seconds. Send it or discard it.`);
      };
      rec.start(250);
      recorder.current = rec; setRecording(true); setSeconds(0); setStatus('Recording. Tap the square to stop.');
    } catch (error) {
      setAlert(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Microphone access was refused. Allow it in the browser to record a note.' : 'The microphone could not be started.');
    }
  }
  const stopRecording = (cancel = false) => { discard.current = cancel; recorder.current?.stop(); };
  // The clock and the hard stop live here, so a forgotten recording ends on its own.
  useEffect(() => {
    if (!recording) return;
    const tick = setInterval(() => setSeconds(current => {
      if (current + 1 >= MAX_TAKE_SECONDS) { recorder.current?.stop(); return current; }
      return current + 1;
    }), 1000);
    return () => clearInterval(tick);
  }, [recording]);
  useEffect(() => () => { discard.current = true; recorder.current?.stop(); }, []);

  async function sendTake() {
    if (!take || controller.current) return;
    if (!endpoint) { setAlert('Assistant is not connected yet. Use the contact button to reach Jim.'); return; }
    const { blob, seconds: length } = take;
    setBusy(true); setAlert(''); setStatus('Transcribing…');
    try {
      let transcript;
      try { transcript = await transcribeAudio(endpoint, await session(), blob); }
      catch (error) {
        if (!(error instanceof SessionExpired)) throw error;
        token.current = undefined; writeToken();
        transcript = await transcribeAudio(endpoint, await session(), blob);
      }
      setTake(null);
      setBusy(false);
      await ask(transcript.text, undefined, { blob, mediaType: blob.type, seconds: length, transcript: transcript.text, model: transcript.model });
    } catch (error) {
      setBusy(false);
      setAlert(error instanceof Error ? error.message : 'The recording could not be transcribed.');
      setStatus('Transcription failed. The recording is still here to retry or discard.');
    }
  }

  async function copy(entry: Entry) {
    try { await navigator.clipboard.writeText(entry.content); setCopied(entry.id); setStatus('Answer copied.'); }
    catch { setAlert('Could not copy. Select the answer text to copy it manually.'); }
  }

  return <div className="assistant-root" ref={setPortal}>
    {/* Modal only while open: the content is force-mounted, and a closed modal would keep its overlay,
        scroll lock and aria-hidden on the page, leaving it dark and untouchable on mobile. */}
    <Sheet open={open} onOpenChange={setOpen} modal={mobile && open}>
      <SheetTrigger asChild>
        <Button className="assistant-launch" variant="default" hidden={open} disabled={!portal} onPointerEnter={preloadTurnstile} onFocus={preloadTurnstile}>
          <MessageSquare size={16} aria-hidden="true" /> Ask about my work
        </Button>
      </SheetTrigger>
      <SheetContent container={portal} data-phase={phase} data-mobile={mobile || undefined}
        // A message rises once, when it arrives. Retiring the animation inline outlives the page
        // swap, where the re-inserted conversation would otherwise fade up again in full.
        onAnimationEnd={event => { if (event.animationName === 'assistant-rise') (event.target as HTMLElement).style.animation = 'none'; }}
        onOpenAutoFocus={event => { if (!mobile) { event.preventDefault(); input.current?.focus(); } }}
        onInteractOutside={event => { if (!mobile) event.preventDefault(); }}>
        {!mobile && <div className="assistant-resizer" role="separator" aria-orientation="vertical" aria-label="Resize assistant panel"
          aria-valuenow={width} aria-valuemin={MIN_WIDTH} aria-valuemax={760} tabIndex={0} onPointerDown={drag}
          onDoubleClick={() => setWidth(clampWidth(DEFAULT_WIDTH))}
          onKeyDown={event => {
            const step = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0;
            if (step) { event.preventDefault(); setWidth(current => clampWidth(current + step)); }
          }} />}
        <header className="assistant-header">
          <SheetTitle className="assistant-title">Legend</SheetTitle>
          <div className="assistant-header-actions">
            <Button size="icon" variant="ghost" aria-label="Clear chat" title="Clear chat" disabled={busy || !entries.length} onClick={() => {
              setEntries([]); setQuestion(''); setTake(null); setCopied(''); setAlert(''); setStatus('Chat cleared.'); setAtBottom(true); follow.current = true; pinned.current = false; anchor.current = ''; input.current?.focus();
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
                  <span aria-hidden="true" />{workingLabel(entry.tools, Boolean(entry.content))}
                </p>}
              </MessageContent>
              {/* Steps and sources sit under the answer. The trace is open while the model works and folds away as
                  the first words arrive, so the answer never streams above a wall of code. */}
              {(!!entry.tools?.length || !!entry.sources?.length || entry.usage) && <details className="chat-trace" open={entry.state === 'streaming' && !entry.content}>
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
            </Message>)}
            <div className="chat-tailspace" ref={spacer} aria-hidden="true" />
          </div>
        </div>
        {!atBottom && !busy && <Button className="assistant-jump" onClick={toBottom}><ArrowDown size={14} aria-hidden="true" /> Latest</Button>}
        <footer className="assistant-footer">
          {alert && <p className="assistant-alert" role="alert">{alert}</p>}
          {/* Empty unless Cloudflare wants a click before the first question is sent. */}
          <div className="assistant-challenge" ref={challengeSlot} />
          {take && <div className="assistant-take" role="group" aria-label="Recorded voice note">
            <AudioBubble audio={{ blob: take.blob, mediaType: take.blob.type, seconds: take.seconds, transcript: '', model: '' }} />
            <div className="assistant-take-actions">
              <Button type="button" variant="default" disabled={busy} onClick={() => void sendTake()}><ArrowUp size={14} aria-hidden="true" /> {busy ? 'Transcribing…' : 'Send'}</Button>
              <Button type="button" size="icon" variant="ghost" aria-label="Discard the recording" title="Discard" disabled={busy} onClick={() => { setTake(null); setStatus('Recording discarded.'); }}><Trash2 size={14} aria-hidden="true" /></Button>
            </div>
          </div>}
          <form className="assistant-form" data-recording={recording || undefined} onSubmit={event => { event.preventDefault(); void ask(question); }}>
            <label htmlFor="assistant-question" className="assistant-sr-only">Your question</label>
            <textarea id="assistant-question" ref={input} value={question} onChange={event => setQuestion(event.target.value)} maxLength={4000} rows={1} required
              placeholder={recording ? `Recording… ${seconds}s` : 'Ask about the work…'} aria-describedby="assistant-privacy" readOnly={busy || recording}
              onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) void ask(question); } }} />
            {recording
              ? <Button type="button" size="icon" variant="default" className="assistant-record" data-recording aria-label="Stop recording" title="Stop recording" onClick={() => stopRecording()}><Square size={14} aria-hidden="true" /></Button>
              : <Button type="button" size="icon" variant="ghost" className="assistant-record" aria-label="Record a voice note" title="Record a voice note" disabled={busy || !!take} onClick={() => void startRecording()}><Mic size={16} aria-hidden="true" /></Button>}
            {busy && controller.current ? <Button type="button" size="icon" aria-label="Stop response" title="Stop response" onClick={() => controller.current?.abort()}><Square size={14} aria-hidden="true" /></Button> :
              <Button type="submit" variant="default" size="icon" aria-label="Send message" title="Send message" disabled={!question.trim() || recording || busy}><ArrowUp size={16} aria-hidden="true" /></Button>}
          </form>
          <p className="assistant-sr-only" role="status" aria-live="polite">{status}</p>
          <p id="assistant-privacy" className="assistant-sr-only">Enter sends, Shift + Enter adds a line. The microphone records a voice note that is transcribed before it is sent.</p>
        </footer>
      </SheetContent>
    </Sheet>
  </div>;
}
