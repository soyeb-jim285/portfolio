import { navigate } from 'astro:transitions/client';
import { findTarget, type SiteTarget } from '../data/site-map';

export type RequestedAction = { id: string; target: string; route: string; anchor: string; label: string; action: 'reveal' | 'contact' };
export type ActionStatus = 'done' | 'missing' | 'failed';

const HIGHLIGHT_MS = 2600;
const READY_TIMEOUT_MS = 6000;

const samePage = (route: string) => new URL(route, location.origin).pathname.replace(/\/$/, '') === location.pathname.replace(/\/$/, '');

// Astro swaps the document on navigation, so wait for the anchor itself rather than a load event.
function waitForAnchor(anchor: string, signal: AbortSignal) {
  return new Promise<HTMLElement | null>(resolve => {
    const existing = document.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`);
    if (existing) return resolve(existing);
    const stop = (element: HTMLElement | null) => { observer.disconnect(); clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(element); };
    const observer = new MutationObserver(() => {
      const found = document.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`);
      if (found) stop(found);
    });
    const onAbort = () => stop(null);
    const timer = setTimeout(() => stop(null), READY_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort, { once: true });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// The model only ever names a target id; the route and selector come from this table, never from its output.
export async function runAction(request: RequestedAction, signal: AbortSignal): Promise<ActionStatus> {
  const target: SiteTarget | undefined = findTarget(request.target);
  if (!target) return 'failed';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (target.action === 'contact') {
    const opener = document.querySelector<HTMLElement>('[data-contact]');
    if (!opener) return 'missing';
    opener.click();
    return document.getElementById('contact-dialog')?.hasAttribute('open') ? 'done' : 'failed';
  }

  try {
    if (!samePage(target.route)) await navigate(target.route);
  } catch { return 'failed'; }

  const element = await waitForAnchor(target.anchor, signal);
  if (!element) return 'missing';
  // Scroll without moving focus: the visitor is still typing in the panel.
  element.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
  element.classList.add('assistant-target');
  setTimeout(() => element.classList.remove('assistant-target'), HIGHLIGHT_MS);
  return 'done';
}

export async function acknowledgeAction(endpoint: string, token: string, id: string, status: ActionStatus) {
  // keepalive: the acknowledgement follows a navigation, and a plain fetch is aborted by it.
  await fetch(`${endpoint.replace(/\/$/, '')}/v1/actions/${id}`, {
    method: 'POST', keepalive: true,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status }),
  }).catch(() => undefined);
}
