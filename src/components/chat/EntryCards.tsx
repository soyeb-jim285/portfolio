import { CalendarClock, Check, Mail, Send } from 'lucide-react';
import { Button } from '../ui/button';
import { dayKey, groupByDay, slotLabel, timeLabel, type Entry } from './panel-shared';
import type { EntryActions } from './panel-actions';
import type { PanelState } from './panel-state';

export function EntrySlots({ entry, panel, actions }: { entry: Entry; panel: PanelState; actions: EntryActions }) {
  const { openDays, setOpenDays } = panel;
  const { chooseSlot } = actions;
  return entry.availability?.map(availability => {
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
  });
}

export function EntryProposals({ entry, actions }: { entry: Entry; actions: EntryActions }) {
  const { confirm, editProposal } = actions;
  return entry.proposals?.map(proposal => { const locked = proposal.state === 'confirming' || proposal.state === 'confirmed';
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
  });
}

export function EntryDraft({ draft, actions }: { draft: NonNullable<Entry['draft']>; actions: EntryActions }) {
  const { editDraft, submitDraft } = actions;
  const locked = draft.state !== 'editing' && draft.state !== 'failed';
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
}
