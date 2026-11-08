import { artifactLink, confirmBooking, proposeSlot, SessionExpired, sendContact, type Availability, type BookingProposal, type Slot } from '../../lib/chat-stream';
import { slotLabel, validEmail, type Entry } from './panel-shared';
import type { PanelState } from './panel-state';

// Built afresh on every render, so each handler sees that render's entries.
export function createEntryActions({ entries, setEntries, setStatus, setAlert, setCopied, setAtBottom, token, viewport, follow }: PanelState, endpoint: string) {
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

  async function copy(entry: Entry) {
    try { await navigator.clipboard.writeText(entry.content); setCopied(entry.id); setStatus('Answer copied.'); }
    catch { setAlert('Could not copy. Select the answer text to copy it manually.'); }
  }

  return { toBottom, retryOf, editDraft, submitDraft, editProposal, confirm, chooseSlot, download, copy };
}

export type EntryActions = ReturnType<typeof createEntryActions>;
