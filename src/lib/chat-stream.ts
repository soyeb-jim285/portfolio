export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type Usage = { ms: number; model: string; promptTokens?: number; completionTokens?: number; costUsd?: number; cached?: boolean };
export type ToolActivity = { id: string; name: string; summary: string; status: 'running' | 'done' | 'error'; ms?: number; detail?: Record<string, string> };
export type SourceCitation = { repo: string; path: string; language: string; symbols: string[]; startLine: number; endLine: number; commit: string; url: string; snippet: string };
export type RequestedUiAction = { id: string; target: string; route: string; anchor: string; label: string; action: 'reveal' | 'contact' };
export type ContactDraft = { id: string; name: string; email: string; message: string; to: string };
export type ShownImage = { id: string; src: string; alt: string; caption: string };
export type Transcript = { text: string; model: string; seconds?: number; costUsd?: number };
export type Artifact = { id: string; kind: string; title: string; bytes: number; markdown: string; expiresAt: string };
export type Slot = { start: string; end: string };
export type Availability = { timeZone: string; durationMinutes: number; label: string; key: string; slots: Slot[] };
export type BookingProposal = { id: string; start: string; end: string; timeZone: string; durationMinutes: number; label: string; key: string; name: string; email: string; notes: string };
export type StreamHandlers = {
  text: (text: string) => void;
  tool: (activity: ToolActivity) => void;
  sources: (sources: SourceCitation[]) => void;
  action: (action: RequestedUiAction) => void;
  draft: (draft: ContactDraft) => void;
  artifact: (artifact: Artifact) => void;
  slots: (availability: Availability) => void;
  proposal: (proposal: BookingProposal) => void;
  usage: (usage: Usage) => void;
  image: (image: ShownImage) => void;
};
export class SessionExpired extends Error {}

const base = (endpoint: string) => endpoint.replace(/\/$/, '');
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
export const browserTimeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

const postJson = (endpoint: string, path: string, body: unknown, token?: string) =>
  fetch(`${base(endpoint)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? auth(token) : {}) },
    body: JSON.stringify(body),
  });

async function fail(response: Response): Promise<never> {
  if (response.status === 401) throw new SessionExpired('Session expired');
  // A slot taken in the meantime comes back with the free ones, so the picker refreshes in place.
  if (response.status === 409) {
    const problem = await response.json().catch(() => ({}));
    const conflict = new Error(typeof problem.error === 'string' ? problem.error : 'That time was just taken.') as Error & { slots?: Slot[] };
    conflict.slots = Array.isArray(problem.slots) ? problem.slots : [];
    throw conflict;
  }
  const problem = await response.json().catch(() => ({}));
  throw new Error(typeof problem.error === 'string' ? problem.error : `Request failed (${response.status}).`);
}

// The challenge is a Turnstile token; the server only asks for one when it has a secret configured.
export async function createSession(endpoint: string, challenge?: string) {
  const response = await fetch(`${base(endpoint)}/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(challenge ? { 'X-Turnstile-Token': challenge } : {}) },
    body: '{}',
  });
  if (!response.ok) await fail(response);
  const { token } = await response.json();
  if (typeof token !== 'string' || !token) throw new Error('The server did not return a session.');
  return token;
}

// The server keeps no conversation, so the recent turns travel with every question.
export async function streamAnswer(endpoint: string, token: string, message: string, history: ChatMessage[], signal: AbortSignal, handlers: StreamHandlers) {
  const response = await fetch(`${base(endpoint)}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Time-Zone': browserTimeZone(), ...auth(token) },
    body: JSON.stringify({ message, history }), signal,
  });
  if (!response.ok) await fail(response);
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('The server did not return an answer stream.');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('The answer was interrupted. Please retry.');
      buffer += value;
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        if (!event || event.version !== 1) throw new Error('Unsupported response version.');
        if (event.type === 'error') throw new Error(typeof event.message === 'string' ? event.message : 'The model could not finish this answer.');
        if (event.type === 'delta' && typeof event.text === 'string') {
          text += event.text;
          if (text.length > 200000) throw new Error('Answer exceeded the display limit.');
          handlers.text(text);
        } else if (event.type === 'tool' && typeof event.id === 'string') {
          handlers.tool(event as ToolActivity);
        } else if (event.type === 'sources' && Array.isArray(event.sources)) {
          handlers.sources(event.sources as SourceCitation[]);
        } else if (event.type === 'action' && event.action?.id) {
          handlers.action(event.action as RequestedUiAction);
        } else if (event.type === 'draft' && event.draft?.id) {
          handlers.draft(event.draft as ContactDraft);
        } else if (event.type === 'artifact' && event.artifact?.id) {
          handlers.artifact(event.artifact as Artifact);
        } else if (event.type === 'slots' && Array.isArray(event.availability?.slots)) {
          handlers.slots(event.availability as Availability);
        } else if (event.type === 'proposal' && event.proposal?.id) {
          handlers.proposal(event.proposal as BookingProposal);
        } else if (event.type === 'image' && event.image?.src) {
          handlers.image(event.image as ShownImage);
        } else if (event.type === 'usage' && typeof event.usage?.ms === 'number') {
          handlers.usage(event.usage as Usage);
        } else if (event.type === 'done' && (event.finishReason === 'stop' || event.finishReason === 'length')) {
          if (!text.trim()) throw new Error('The model returned an empty answer. Please retry.');
          return { text, finishReason: event.finishReason as 'stop' | 'length' };
        }
        // Unknown event types are ignored so an older page keeps working against a newer API.
      }
      if (buffer.length > 200000) throw new Error('Response frame exceeded its size limit.');
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

// The only call that reaches the email provider, and it carries exactly what the visitor saw.
export async function sendContact(endpoint: string, token: string | undefined, draft: { draftId?: string; name: string; email: string; message: string }) {
  const response = await postJson(endpoint, '/v1/contact', draft, token);
  if (!response.ok) await fail(response);
  return await response.json() as { id: string; status: 'accepted' | 'already-sent' };
}

// The object is private; this exchanges a session for a link that expires within minutes.
export async function artifactLink(endpoint: string, token: string, id: string) {
  const response = await fetch(`${base(endpoint)}/v1/artifacts/${id}`, { headers: auth(token) });
  if (!response.ok) await fail(response);
  return await response.json() as { url: string; title: string; expiresInSeconds: number };
}

// Confirming a call: the visitor's own click, carrying the slot and details they saw.
export async function confirmBooking(endpoint: string, token: string, booking: { proposalId: string; start: string; name: string; email: string; timeZone: string }) {
  const response = await postJson(endpoint, '/v1/bookings', booking, token);
  if (!response.ok) await fail(response);
  return await response.json() as { id: string; uid: string; start: string; status: 'confirmed' | 'already-booked' };
}

// Picking a slot holds it for confirmation, so a visitor can book even when the model only listed times.
export async function proposeSlot(endpoint: string, token: string, slot: { start: string; key: string; timeZone: string }) {
  const response = await postJson(endpoint, '/v1/proposals', slot, token);
  if (!response.ok) await fail(response);
  return await response.json() as BookingProposal;
}

// A recording goes up once as a data URL and comes back as text. The blob itself stays in this
// browser: the transcript is what the conversation carries, and what the model ever sees.
const toDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error('Could not read the recording.'));
  reader.readAsDataURL(blob);
});
export async function transcribeAudio(endpoint: string, token: string, blob: Blob, signal?: AbortSignal): Promise<Transcript> {
  if (blob.size > 8_000_000) throw new Error('That recording is too long to send. Keep it under a couple of minutes.');
  const response = await fetch(`${base(endpoint)}/v1/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(token) },
    body: JSON.stringify({ mediaType: blob.type || 'audio/webm', dataUrl: await toDataUrl(blob) }),
    signal,
  });
  if (!response.ok) await fail(response);
  const transcript = await response.json() as Transcript;
  if (typeof transcript.text !== 'string' || !transcript.text.trim()) throw new Error('Nothing was heard in that recording.');
  return transcript;
}
