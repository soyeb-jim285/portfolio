import { SessionExpired, streamAnswer, type Artifact, type Availability, type BookingProposal, type ChatMessage, type ContactDraft, type GeneratedUi, type RequestedUiAction, type ShownImage, type SourceCitation, type ToolActivity, type Usage } from '../../lib/chat-stream';
import { workingLabel } from '../../lib/chat-progress';
import { acknowledgeAction, runAction, type ActionStatus } from '../../lib/site-actions';
import { HISTORY_CHARS, HISTORY_TURNS, IDLE_TIMEOUT_MS, writeToken, type Entry } from './panel-shared';
import type { PanelState } from './panel-state';

// Built afresh on every render, so each ask() sees that render's entries, exactly as an inline function would.
export function createAsk(
  { entries, setEntries, setQuestion, setBusy, setStatus, setAlert, setAtBottom, token, performed, controller, follow, anchor, pinned }: PanelState,
  endpoint: string, session: () => Promise<string>, fit: () => void, toAnchor: (behavior?: ScrollBehavior) => void,
) {
  return async function ask(value: string, replacing?: string[], audio?: Entry['audio']) {
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
      ui: (ui: GeneratedUi) => patch(entry => ({ ...entry, ui })),
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
  };
}

export type Ask = ReturnType<typeof createAsk>;
