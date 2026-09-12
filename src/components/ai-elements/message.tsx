// Adapted from https://registry.ai-sdk.dev/message.json (AI Elements).
// Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
// Changes: retain the message/content/response/action primitives used here,
// replace utility styling with portfolio CSS, and omit unused branch/attachment UI.
import { lazy, memo, Suspense, useEffect, useState, type ComponentProps, type HTMLAttributes } from 'react';
import type { StreamdownProps } from 'streamdown';
import { Button } from '../ui/button';

// Load Markdown and the syntax highlighter on demand, keeping the portfolio's initial load
// light. Call preloadResponse() when the panel opens so both are ready before the first token.
export const preloadResponse = () => Promise.all([import('streamdown'), import('@streamdown/code')]);
const Streamdown = lazy(() => preloadResponse().then(([module]) => ({ default: module.Streamdown })));

// Shiki themes chosen to sit on the site's navy: one palette, loaded once, shared by every block.
let highlighter: Promise<import('streamdown').PluginConfig> | undefined;
const codePlugins = () => (highlighter ??= import('@streamdown/code').then(module => ({
  code: module.createCodePlugin({ themes: ['github-dark-dimmed', 'github-dark-dimmed'] }),
})));

export function Message({ className = '', from, ...props }: HTMLAttributes<HTMLDivElement> & { from: 'user' | 'assistant' }) {
  return <div data-slot="message" className={`chat-message is-${from} ${className}`} {...props} />;
}

export function MessageContent({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="message-content" className={`chat-message-content ${className}`} {...props} />;
}

export function MessageActions({ className = '', ...props }: ComponentProps<'div'>) {
  return <div className={`chat-message-actions ${className}`} {...props} />;
}

export function MessageAction({ label, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return <Button type="button" variant="ghost" size="icon" aria-label={label} title={label} {...props} />;
}

export const MessageResponse = memo(function MessageResponse({ className = '', ...props }: StreamdownProps) {
  const [plugins, setPlugins] = useState<import('streamdown').PluginConfig | undefined>(undefined);
  // Highlighting arrives a beat after the text; the block is readable either way.
  useEffect(() => { let live = true; void codePlugins().then(loaded => { if (live) setPlugins(loaded); }); return () => { live = false; }; }, []);
  // Never fall back to the raw source: unrendered Markdown reads as a bug.
  return <Suspense fallback={<div className="chat-loading" aria-label="Rendering answer"><span /><span /><span /></div>}>
    <Streamdown className={`chat-response ${className}`} plugins={plugins} {...props} />
  </Suspense>;
});
