// Adapted from https://registry.ai-sdk.dev/message.json (AI Elements).
// Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
// Changes: retain the message/content/response/action primitives used here,
// replace utility styling with portfolio CSS, and omit unused branch/attachment UI.
import { lazy, memo, Suspense, useEffect, useState, type ComponentProps, type HTMLAttributes } from 'react';
import type { StreamdownProps } from 'streamdown';
import { loadMermaid } from '../chat/Diagram';

// Shiki themes chosen to sit on the site's navy: one palette, loaded once, shared by every block.
// Kept once resolved, so a message mounted later renders highlighted on its first pass instead of
// rendering plain and then again with colour.
let plugins: import('streamdown').PluginConfig | undefined;
let highlighter: Promise<import('streamdown').PluginConfig> | undefined;
const THEMES: ['github-dark-dimmed', 'github-dark-dimmed'] = ['github-dark-dimmed', 'github-dark-dimmed'];
const codePlugins = () => (highlighter ??= import('@streamdown/code').then(module => {
  const code = module.createCodePlugin({ themes: THEMES });
  // Shiki compiles a grammar on first use, on the main thread: C++ alone stalls a frame for about
  // half a second. Most answers here quote C++, so it is compiled while the browser is idle rather
  // than in the middle of the first streamed code block.
  // ponytail: one warmed language; a worker-side highlighter if other grammars ever show up in profiles.
  const warm = () => code.highlight({ code: ' ', language: 'cpp', themes: THEMES });
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 }); else setTimeout(warm, 1500);
  // Mermaid fences in an answer render as diagrams through the same strict, themed instance the
  // document cards use; Streamdown's own config is ignored so it cannot loosen securityLevel.
  const mermaid = {
    name: 'mermaid' as const, type: 'diagram' as const, language: 'mermaid',
    getMermaid: () => ({ initialize() {}, render: (id: string, source: string) => loadMermaid().then(instance => instance.render(id, source)) }),
  };
  return (plugins = { code, mermaid });
}));

// Load Markdown and the syntax highlighter on demand, keeping the portfolio's initial load light.
// Call preloadResponse() as soon as there is anything to render, so both are ready before it paints.
let renderer: Promise<unknown> | undefined;
export const preloadResponse = () => (renderer ??= Promise.all([import('streamdown'), codePlugins()]));
const Streamdown = lazy(() => preloadResponse().then(() => import('streamdown')).then(({ Streamdown: Renderer, defaultRehypePlugins }) => {
  // A link the sanitiser refuses, such as a bare file path the model linked, reads as its own text
  // instead of the words and a "[blocked]" marker.
  const [harden, options] = defaultRehypePlugins.harden as [NonNullable<StreamdownProps['rehypePlugins']>[number], object];
  const rehypePlugins = Object.values({ ...defaultRehypePlugins, harden: [harden, { ...options, linkBlockPolicy: 'text-only' }] }) as StreamdownProps['rehypePlugins'];
  return { default: (props: StreamdownProps) => <Renderer rehypePlugins={rehypePlugins} {...props} /> };
}));

export function Message({ className = '', from, ...props }: HTMLAttributes<HTMLDivElement> & { from: 'user' | 'assistant' }) {
  return <div data-slot="message" className={`chat-message is-${from} ${className}`} {...props} />;
}

export function MessageContent({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="message-content" className={`chat-message-content ${className}`} {...props} />;
}

export function MessageActions({ className = '', ...props }: ComponentProps<'div'>) {
  return <div className={`chat-message-actions ${className}`} {...props} />;
}


export const MessageResponse = memo(function MessageResponse({ className = '', ...props }: StreamdownProps) {
  const [ready, setReady] = useState(plugins);
  // Only a message mounted before the highlighter finished loading waits for it; the rest start coloured.
  useEffect(() => { if (ready) return; let live = true; void codePlugins().then(loaded => { if (live) setReady(loaded); }); return () => { live = false; }; }, [ready]);
  // Never fall back to the raw source: unrendered Markdown reads as a bug.
  return <Suspense fallback={<div className="chat-loading" aria-label="Rendering answer"><span /><span /><span /></div>}>
    <Streamdown className={`chat-response ${className}`} plugins={ready} {...props} />
  </Suspense>;
});
