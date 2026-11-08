import { useCallback, useEffect, useRef, useState } from 'react';
import { preloadResponse } from '../ai-elements/message';
import { createSession } from '../../lib/chat-stream';
import { clearConversation, loadConversation, saveConversation } from '../../lib/chat-history';
import { turnstileToken } from '../../lib/turnstile';
import { clampWidth, headRoom, readToken, writeToken, type Entry } from './panel-shared';
import type { PanelState } from './panel-state';

export function usePanelLayout({ width, setMobile, setWidth, controller }: PanelState) {
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
}

export function usePanelPhase(open: boolean) {
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
  return phase;
}

export function useConversationStore({ entries, setEntries, token, loaded, performed }: PanelState) {
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
}

export function useScrollPin({ entries, open, viewport, spacer, anchor, pinned, follow }: PanelState) {
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
  return { fit, toAnchor };
}

export function useResizeDrag({ setWidth }: PanelState) {
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
  return drag;
}

export function useSession({ open, token, challengeSlot }: PanelState, endpoint: string) {
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
  return session;
}
