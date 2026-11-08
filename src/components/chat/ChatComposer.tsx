import { ArrowUp, Mic, Square, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { AudioBubble } from './ChatPrimitives';
import type { Ask } from './panel-ask';
import type { PanelState } from './panel-state';
import type { Voice } from './panel-voice';

export default function ChatComposer({ panel, ask, voice }: { panel: PanelState; ask: Ask; voice: Voice }) {
  const { status, alert, challengeSlot, take, setTake, busy, setStatus, recording, question, setQuestion, input, seconds, controller } = panel;
  const { sendTake, startRecording, stopRecording } = voice;
  return <footer className="assistant-footer">
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
  </footer>;
}
