import { useEffect } from 'react';
import { SessionExpired, transcribeAudio } from '../../lib/chat-stream';
import { MAX_TAKE_SECONDS, VOICE_MIME_TYPES, writeToken } from './panel-shared';
import type { Ask } from './panel-ask';
import type { PanelState } from './panel-state';

export function useVoice({ take, setTake, recording, setRecording, setSeconds, setBusy, setStatus, setAlert, recorder, discard, token, controller }: PanelState, endpoint: string, session: () => Promise<string>, ask: Ask) {
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

  return { startRecording, stopRecording, sendTake };
}

export type Voice = ReturnType<typeof useVoice>;
