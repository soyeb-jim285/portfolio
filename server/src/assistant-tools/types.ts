import type { Retrieval, SourceHit } from '../retrieval';

export type UiAction = { target: string; route: string; anchor: string; label: string; action: 'reveal' | 'contact' };
export type ShownImage = { id: string; src: string; alt: string; caption: string };
export type ContactDraft = { name: string; email: string; message: string };
export type ArtifactRequest = { kind: string; title: string; markdown: string };
export type EventTypeChoice = { minutes: number; label: string; key: string };
export type BookingProposal = { eventType: EventTypeChoice; start: string; name: string; email: string; notes: string };
export type Slot = { start: string; end: string };
export type ToolOutcome = {
  summary: string; result: string; sources: SourceHit[];
  // Set when the tool could not do what was asked, so the answer built on it is not reused.
  failed?: true;
  // Set when the result is live data, so the answer is not replayed to a later visitor as current.
  live?: true;
  action?: UiAction; draft?: ContactDraft; artifact?: ArtifactRequest; image?: ShownImage;
  slots?: { timeZone: string; eventType: EventTypeChoice; slots: Slot[] }; proposal?: BookingProposal;
};

export type ToolContext = {
  retrieval: Retrieval;
  repoNames: string[];
  contactEnabled: boolean;
  artifactsEnabled: boolean;
  maxArtifactBytes: number;
  github?: { owner: string; get<T>(path: string): Promise<T> };
  scheduling?: { timeZone: string; eventTypes: EventTypeChoice[]; availability(eventType: EventTypeChoice): Promise<Slot[]> };
};
