import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileText, Maximize2, Minimize2, Printer, X } from 'lucide-react';
import Diagram from './Diagram';
import { Button } from '../ui/button';
import { MessageResponse } from '../ai-elements/message';

type Artifact = { id: string; kind: string; title: string; bytes: number; markdown?: string; expiresAt: string };

// A document is worth reading at a document's width, not a chat bubble's. Opening one covers the
// panel (or the viewport, once fullscreen) and renders it with the same highlighter and Mermaid the
// answers use. The markdown is the artifact; this is only a better surface for it.
export default function ArtifactView({ artifact, markdown, onDownload, markdownOptions }: {
  artifact: Artifact;
  markdown: string;
  onDownload: () => void;
  markdownOptions: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const view = useRef<HTMLDivElement>(null);
  // The document belongs to the panel, not to the message that produced it: as a child of the
  // scrolling list it would inherit the list's clipping, and printing hides that list.
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => { if (open) setHost(anchor.current?.closest<HTMLElement>('.assistant-panel') ?? null); }, [open]);

  // Native fullscreen where the browser allows it on any element; iPhone Safari only allows video,
  // so there the view covers the viewport instead. Escape and the browser's own exit both close it.
  useEffect(() => {
    const sync = () => setExpanded(document.fullscreenElement === view.current);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setExpanded(false); setOpen(false); } };
    document.addEventListener('fullscreenchange', sync);
    if (open) document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('fullscreenchange', sync); document.removeEventListener('keydown', escape); };
  }, [open, expanded]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (expanded) setExpanded(false);
    else if (view.current?.requestFullscreen) view.current.requestFullscreen().catch(() => setExpanded(true));
    else setExpanded(true);
  };

  // The browser's own engine writes the PDF. A renderer on the server would mean shipping Chromium
  // to print 64KB of Markdown, and it would rasterise the Mermaid that prints here as vectors.
  const print = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    document.documentElement.setAttribute('data-printing-artifact', '');
    const clear = () => document.documentElement.removeAttribute('data-printing-artifact');
    addEventListener('afterprint', clear, { once: true });
    // Let the attribute paint before the print dialog freezes the page.
    requestAnimationFrame(() => requestAnimationFrame(() => { window.print(); setTimeout(clear, 1000); }));
  };

  const diagram = artifact.kind === 'diagram' ? markdown.match(/```mermaid\n([\s\S]*?)```/)?.[1] : undefined;
  const kept = new Date(artifact.expiresAt).toLocaleDateString();

  const panel = open && host ? createPortal(
    <div className="chat-artifact-view" ref={view} data-expanded={expanded || undefined} role="dialog" aria-label={artifact.title}>
      <header className="chat-artifact-bar">
        <span className="chat-artifact-bar-title"><FileText size={13} aria-hidden="true" /> {artifact.title}</span>
        <span className="chat-artifact-bar-actions">
          <Button type="button" variant="ghost" onClick={print} title="Print or save as PDF"><Printer size={13} aria-hidden="true" /> PDF</Button>
          <Button type="button" variant="ghost" onClick={onDownload} title="Download the Markdown"><Download size={13} aria-hidden="true" /> .md</Button>
          <Button type="button" size="icon" variant="ghost" onClick={toggleFullscreen} aria-pressed={expanded}
            aria-label={expanded ? 'Leave fullscreen' : 'Fullscreen'} title={expanded ? 'Leave fullscreen' : 'Fullscreen'}>
            {expanded ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
          </Button>
          <Button type="button" size="icon" variant="ghost" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); setOpen(false); }}
            aria-label="Close the document" title="Close"><X size={15} aria-hidden="true" /></Button>
        </span>
      </header>
      <div className="chat-artifact-page">
        <article className="chat-artifact-doc">
          <h1>{artifact.title}</h1>
          {diagram
            ? <Diagram source={diagram} title={artifact.title} />
            : <MessageResponse {...markdownOptions}>{markdown}</MessageResponse>}
          <footer className="chat-artifact-colophon">
            {artifact.kind} · {Math.max(1, Math.round(artifact.bytes / 1024))} KB · generated by the assistant on soyebjim.me · kept until {kept}
          </footer>
        </article>
      </div>
    </div>, host) : null;

  return <>
    <span ref={anchor} hidden />
    <Button type="button" onClick={() => setOpen(true)}><FileText size={13} aria-hidden="true" /> Open</Button>
    {panel}
  </>;
}
