import { useEffect, useRef, useState } from 'react';
import { Download, Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '../ui/button';

// Mermaid runs with htmlLabels and script execution off, so a model-written diagram can only
// ever produce shapes and text. It is loaded on demand: no diagram, no bundle.
const MAX_DIAGRAM_CHARS = 6000;
const PNG_SCALE = 2;
let mermaidReady: Promise<typeof import('mermaid').default> | undefined;

export const loadMermaid = () => (mermaidReady ??= import('mermaid').then(module => {
  module.default.initialize({
    startOnLoad: false, securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false },
    theme: 'base',
    themeVariables: {
      darkMode: true, background: '#132646', primaryColor: '#132646', primaryTextColor: '#e7edf7',
      primaryBorderColor: '#e8933f', lineColor: '#a3b3cb', secondaryColor: '#0f1f3a', tertiaryColor: '#0f1f3a',
      fontFamily: 'IBM Plex Mono, ui-monospace, monospace', fontSize: '13px',
    },
  });
  return module.default;
}));

const fileName = (title: string, extension: string) =>
  `${(title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'diagram')}.${extension}`;

const save = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // Revoke on the next frame: revoking immediately can cancel the download in some browsers.
  requestAnimationFrame(() => URL.revokeObjectURL(url));
};

// The rendered SVG carries its size in the viewBox; the inline max-width style does not survive export.
const sizeOf = (svg: string) => {
  const [, , width, height] = svg.match(/viewBox="([\d.-]+) ([\d.-]+) ([\d.]+) ([\d.]+)"/)?.slice(1).map(Number) ?? [];
  return { width: width || 960, height: height || 540 };
};

export default function Diagram({ source, title = 'diagram' }: { source: string; title?: string }) {
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const figure = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  // Set on every mount, not just the first: React re-runs mount effects in development.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Native fullscreen where the browser allows it on any element; iPhone Safari only allows video,
  // so there the figure covers the viewport instead. Escape and the browser's own exit both close it.
  useEffect(() => {
    const sync = () => setExpanded(document.fullscreenElement === figure.current);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false); };
    document.addEventListener('fullscreenchange', sync);
    if (expanded && !document.fullscreenElement) document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('fullscreenchange', sync); document.removeEventListener('keydown', escape); };
  }, [expanded]);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (expanded) setExpanded(false);
    else if (figure.current?.requestFullscreen) figure.current.requestFullscreen().catch(() => setExpanded(true));
    else setExpanded(true);
  };

  useEffect(() => {
    if (source.length > MAX_DIAGRAM_CHARS) { setFailed(true); return; }
    // A fresh id per attempt: mermaid keys its scratch element by id, and reusing one across
    // a remount loses the result. Only the mount flag gates the state update.
    const renderId = `diagram-${Math.random().toString(36).slice(2)}`;
    loadMermaid()
      .then(mermaid => mermaid.render(renderId, source))
      .then(result => { if (mounted.current) { setSvg(result.svg); setFailed(false); } })
      .catch(() => { if (mounted.current) setFailed(true); });
  }, [source]);

  const downloadSvg = () => {
    const { width, height } = sizeOf(svg);
    // Give the standalone file an explicit size and an opaque background, so it is readable outside the panel.
    const standalone = svg
      .replace(/<svg /, `<svg width="${width}" height="${height}" `)
      .replace(/(<svg[^>]*>)/, `$1<rect width="100%" height="100%" fill="#0f1f3a"/>`);
    save(new Blob([standalone], { type: 'image/svg+xml;charset=utf-8' }), fileName(title, 'svg'));
  };

  const downloadPng = async () => {
    setBusy(true);
    try {
      const { width, height } = sizeOf(svg);
      const image = new Image();
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      try {
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error('The diagram could not be rasterised'));
          image.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = width * PNG_SCALE;
        canvas.height = height * PNG_SCALE;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#0f1f3a';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
        if (blob) save(blob, fileName(title, 'png'));
      } finally { URL.revokeObjectURL(url); }
    } catch { /* the SVG button still works */ }
    finally { setBusy(false); }
  };

  // Fall back to the source rather than an error: the text is still useful and always inert.
  if (failed || !svg) return <pre className="chat-diagram-source"><code>{source}</code></pre>;
  return <figure className="chat-diagram" ref={figure} data-expanded={expanded || undefined}>
    {/* Mermaid's strict mode sanitises its own output; this is the only place it is inserted. */}
    <div className="chat-diagram-canvas" dangerouslySetInnerHTML={{ __html: svg }} />
    <figcaption>
      <Button type="button" onClick={downloadSvg}><Download size={12} aria-hidden="true" /> SVG</Button>
      <Button type="button" onClick={() => void downloadPng()} disabled={busy}><Download size={12} aria-hidden="true" /> {busy ? 'PNG…' : 'PNG'}</Button>
      <Button type="button" className="chat-diagram-fullscreen" onClick={toggleFullscreen} aria-pressed={expanded}>
        {expanded ? <Minimize2 size={12} aria-hidden="true" /> : <Maximize2 size={12} aria-hidden="true" />} {expanded ? 'Exit full screen' : 'Full screen'}
      </Button>
    </figcaption>
  </figure>;
}
