import { useEffect } from 'react';
import { ArrowDown, ArrowRight, MessageSquare, Trash2, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '../ui/sheet';
import { preloadTurnstile } from '../../lib/turnstile';
import { starters } from '../../data/assistant-questions';
import ChatComposer from './ChatComposer';
import ChatEntry from './ChatEntry';
import { createEntryActions } from './panel-actions';
import { createAsk } from './panel-ask';
import { useConversationStore, usePanelLayout, usePanelPhase, useResizeDrag, useScrollPin, useSession } from './panel-hooks';
import { clampWidth, DEFAULT_WIDTH, MIN_WIDTH } from './panel-shared';
import { usePanelState } from './panel-state';
import { useVoice } from './panel-voice';

export default function ChatPanel({ endpoint }: { endpoint: string }) {
  const panel = usePanelState();
  const { open, setOpen, mobile, portal, setPortal, entries, setEntries, setQuestion, busy, setStatus, setAlert, setCopied, atBottom, setAtBottom, width, setWidth, setTake, input, viewport, follow, anchor, spacer, pinned } = panel;

  // Hooks below run in the order the panel depends on: layout, ask listener, phase, storage, scroll, drag, session, voice.
  usePanelLayout(panel);
  // Any element on the site can open the panel with a question or a repository already chosen.
  // Re-registered every render on purpose, so the handler always calls the current ask().
  useEffect(() => {
    const onAsk = (event: Event) => {
      const detail = (event as CustomEvent<{ question?: string; repo?: string; path?: string }>).detail ?? {};
      setOpen(true);
      if (detail.question) void ask(detail.question);
    };
    addEventListener('assistant:ask', onAsk);
    return () => removeEventListener('assistant:ask', onAsk);
  });
  const phase = usePanelPhase(open);
  useConversationStore(panel);
  const { fit, toAnchor } = useScrollPin(panel);
  const drag = useResizeDrag(panel);
  const session = useSession(panel, endpoint);
  const ask = createAsk(panel, endpoint, session, fit, toAnchor);
  const actions = createEntryActions(panel, endpoint);
  const voice = useVoice(panel, endpoint, session, ask);
  const { toBottom } = actions;

  return <div className="assistant-root" ref={setPortal}>
    {/* Modal only while open: the content is force-mounted, and a closed modal would keep its overlay,
        scroll lock and aria-hidden on the page, leaving it dark and untouchable on mobile. */}
    <Sheet open={open} onOpenChange={setOpen} modal={mobile && open}>
      <SheetTrigger asChild>
        <Button className="assistant-launch" variant="default" hidden={open} disabled={!portal} onPointerEnter={preloadTurnstile} onFocus={preloadTurnstile}>
          <MessageSquare size={16} aria-hidden="true" /> Ask about my work
        </Button>
      </SheetTrigger>
      <SheetContent container={portal} data-phase={phase} data-mobile={mobile || undefined}
        // A message rises once, when it arrives. Retiring the animation inline outlives the page
        // swap, where the re-inserted conversation would otherwise fade up again in full.
        onAnimationEnd={event => { if (event.animationName === 'assistant-rise') (event.target as HTMLElement).style.animation = 'none'; }}
        onOpenAutoFocus={event => { if (!mobile) { event.preventDefault(); input.current?.focus(); } }}
        onInteractOutside={event => { if (!mobile) event.preventDefault(); }}>
        {!mobile && <div className="assistant-resizer" role="separator" aria-orientation="vertical" aria-label="Resize assistant panel"
          aria-valuenow={width} aria-valuemin={MIN_WIDTH} aria-valuemax={760} tabIndex={0} onPointerDown={drag}
          onDoubleClick={() => setWidth(clampWidth(DEFAULT_WIDTH))}
          onKeyDown={event => {
            const step = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0;
            if (step) { event.preventDefault(); setWidth(current => clampWidth(current + step)); }
          }} />}
        <header className="assistant-header">
          <SheetTitle className="assistant-title">Legend</SheetTitle>
          <div className="assistant-header-actions">
            <Button size="icon" variant="ghost" aria-label="Clear chat" title="Clear chat" disabled={busy || !entries.length} onClick={() => {
              setEntries([]); setQuestion(''); setTake(null); setCopied(''); setAlert(''); setStatus('Chat cleared.'); setAtBottom(true); follow.current = true; pinned.current = false; anchor.current = ''; input.current?.focus();
            }}><Trash2 size={15} aria-hidden="true" /></Button>
            <SheetClose asChild><Button size="icon" variant="ghost" aria-label="Close assistant"><X size={17} aria-hidden="true" /></Button></SheetClose>
          </div>
        </header>
        <SheetDescription className="assistant-sr-only">Ask about Jim’s projects, engineering work and research. Answers come from public portfolio content.</SheetDescription>
        <div className="assistant-body" ref={viewport}
          onWheel={() => { pinned.current = false; }} onTouchMove={() => { pinned.current = false; }}
          onScroll={() => {
          // While a turn is running the pinned question owns the scroll position; scrolling must not re-arm follow.
          if (busy) return;
          const el = viewport.current!; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; setAtBottom(follow.current);
        }}>
          {!entries.length && <div className="assistant-empty">
            <h3>Ask about the work.</h3>
            <p>It reads the source of Jim's repositories before answering, shows the lines it read, and can take you to a page, draft a message or find a time to talk.</p>
            <div className="assistant-prompts">{starters.map(({ tag, question: starter }) =>
              <Button key={tag} onClick={() => void ask(starter)}><span><small>{tag}</small>{starter}</span><ArrowRight size={15} aria-hidden="true" /></Button>
            )}</div>
          </div>}
          <div className="assistant-messages" role="log" aria-label="Conversation" aria-live="off" aria-busy={busy}>
            {entries.map(entry => <ChatEntry key={entry.id} entry={entry} panel={panel} ask={ask} actions={actions} />)}
            <div className="chat-tailspace" ref={spacer} aria-hidden="true" />
          </div>
        </div>
        {!atBottom && !busy && <Button className="assistant-jump" onClick={toBottom}><ArrowDown size={14} aria-hidden="true" /> Latest</Button>}
        <ChatComposer panel={panel} ask={ask} voice={voice} />
      </SheetContent>
    </Sheet>
  </div>;
}
