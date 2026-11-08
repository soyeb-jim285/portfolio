import type { Artifact, Availability, BookingProposal, ContactDraft, GeneratedUi, RequestedUiAction, Slot, SourceCitation, ShownImage, ToolActivity, Usage } from '../../lib/chat-stream';
import type { ActionStatus } from '../../lib/site-actions';

export type Entry = {
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
  ui?: GeneratedUi;
  // A voice note keeps its recording and its transcript together; the transcript is what was sent.
  audio?: { blob: Blob; mediaType: string; seconds: number; transcript: string; model: string };
};

export const slotLabel = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(iso));
export const timeLabel = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(iso));
export const dayKey = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(new Date(iso));
const dayLabel = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(new Date(iso));

// Slots arrive as one flat list; a picker is only usable grouped by the visitor's own day.
export function groupByDay(slots: Slot[], timeZone: string) {
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
export const readToken = () => { try { return localStorage.getItem(SESSION_KEY) ?? undefined; } catch { return undefined; } };
export const writeToken = (token?: string) => { try { token ? localStorage.setItem(SESSION_KEY, token) : localStorage.removeItem(SESSION_KEY); } catch {} };
// Good enough to catch a typo before a round trip; the server validates properly.
export const validEmail = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
// Mirrors the server's defaults (MAX_MESSAGES_PER_SESSION, MAX_CONTEXT_CHARS); it trims again either way.
export const HISTORY_TURNS = 40;
export const HISTORY_CHARS = 24000;
// Shared by reference: MessageResponse is memoised, and fresh object literals on every render would
// re-parse every earlier answer each time a streamed chunk arrives.
export const MARKDOWN = { skipHtml: true, disallowedElements: ['img'], linkSafety: { enabled: false }, controls: { code: { copy: true, download: false }, table: false, mermaid: { download: true, copy: false, fullscreen: true, panZoom: true } } } as const;
// Silence, not total length, ends a turn: a long answer keeps streaming as long as events keep arriving.
export const IDLE_TIMEOUT_MS = 90000;
export const MIN_WIDTH = 340;

// How much of the scroller the floating header covers, which is scroll-padding-top where it floats.
export const headRoom = (box: HTMLElement) => parseFloat(getComputedStyle(box).scrollPaddingTop) || 0;
export const DEFAULT_WIDTH = 420;
// Spelled-out codecs: Chrome claims plain audio/mp4 and then records opus in it, which nothing plays.
export const VOICE_MIME_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
export const MAX_TAKE_SECONDS = 120;
export const clampWidth = (value: number) => Math.round(Math.min(Math.max(value, MIN_WIDTH), Math.max(MIN_WIDTH, Math.min(760, window.innerWidth - 96))));
