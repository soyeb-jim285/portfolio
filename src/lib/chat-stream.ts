export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type Usage = { ms: number; model: string; promptTokens?: number; completionTokens?: number; costUsd?: number };
export type ToolActivity = { id: string; name: string; summary: string; status: 'running' | 'done' | 'error'; ms?: number };
export type SourceCitation = { repo: string; path: string; language: string; symbols: string[]; startLine: number; endLine: number; commit: string; url: string; snippet: string };
export type StoredMessage = ChatMessage & { sources: SourceCitation[]; tools: { name: string; summary: string; ms: number }[]; actions: { id: string; target: string; label: string; route: string }[]; artifacts: Omit<Artifact, 'markdown'>[]; proposals: BookingProposal[]; images: ShownImage[]; usage?: Usage };
export type RequestedUiAction = { id: string; target: string; route: string; anchor: string; label: string; action: 'reveal' | 'contact' };
export type ContactDraft = { id: string; name: string; email: string; message: string; to: string };
export type ShownImage = { id: string; src: string; alt: string; caption: string };
export type Attachment = { mediaType: string; dataUrl: string; name: string };
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

export async function createSession(endpoint: string) {
  const response = await postJson(endpoint, '/v1/sessions', {});
  if (!response.ok) await fail(response);
  const { token } = await response.json();
  if (typeof token !== 'string' || !token) throw new Error('The server did not return a session.');
  return token;
}

export async function loadMessages(endpoint: string, token: string): Promise<StoredMessage[]> {
  const response = await fetch(`${base(endpoint)}/v1/messages`, { headers: auth(token) });
  if (!response.ok) await fail(response);
  const { messages } = await response.json();
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(entry => (entry?.role === 'user' || entry?.role === 'assistant') && typeof entry.content === 'string')
    .map(entry => ({
      role: entry.role, content: entry.content,
      sources: Array.isArray(entry.metadata?.sources) ? entry.metadata.sources : [],
      actions: Array.isArray(entry.metadata?.actions) ? entry.metadata.actions : [],
      artifacts: Array.isArray(entry.metadata?.artifacts) ? entry.metadata.artifacts : [],
      images: Array.isArray(entry.metadata?.images) ? entry.metadata.images : [],
      proposals: Array.isArray(entry.metadata?.proposals) ? entry.metadata.proposals : [],
      usage: entry.metadata?.usage,
      tools: Array.isArray(entry.metadata?.tools) ? entry.metadata.tools : [],
    }));
}

export async function clearMessages(endpoint: string, token: string) {
  const response = await fetch(`${base(endpoint)}/v1/messages`, { method: 'DELETE', headers: auth(token) });
  if (!response.ok) await fail(response);
}

export async function streamAnswer(endpoint: string, token: string, message: string, signal: AbortSignal, handlers: StreamHandlers, attachment?: Attachment) {
  const response = await fetch(`${base(endpoint)}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Time-Zone': browserTimeZone(), ...auth(token) },
    body: JSON.stringify(attachment ? { message, attachment: { mediaType: attachment.mediaType, dataUrl: attachment.dataUrl } } : { message }), signal,
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

// Downscale in the browser so a phone photo does not become a six megabyte request.
export async function prepareAttachment(file: File, maxEdge = 1400, quality = 0.82): Promise<Attachment> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Attach a PNG, JPEG, WebP or GIF image.');
  if (file.size > 20_000_000) throw new Error('That image is too large. Try one under 20 MB.');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Re-encoding also strips metadata, so location and camera details never leave the browser.
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length > 3_800_000) throw new Error('That image is too detailed to send. Try a smaller one.');
    return { mediaType: 'image/jpeg', dataUrl, name: file.name };
  } finally { bitmap.close(); }
}
