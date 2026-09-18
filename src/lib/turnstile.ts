// Cloudflare Turnstile, asked for only when a visitor starts a conversation or sends the contact
// form. The script loads on that first use, so an ordinary page view pulls in nothing from Cloudflare.
// Most visitors never see a widget; the few Cloudflare is unsure about get one click in the slot.
type Turnstile = {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
};

// A site key is public by design (it ships in every page that renders the widget), so production
// carries it here. PUBLIC_TURNSTILE_SITE_KEY overrides it, and an empty value switches the check off,
// which is what a local build wants: the widget only renders on the hostnames Cloudflare allows.
const PRODUCTION_SITE_KEY = '0x4AAAAAAE79LNzIa5cWrGzp';
const SITE_KEY: string | undefined = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY ?? (import.meta.env.PROD ? PRODUCTION_SITE_KEY : undefined);
let loading: Promise<Turnstile> | undefined;

function load() {
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => {
      const api = (window as unknown as { turnstile?: Turnstile }).turnstile;
      api ? resolve(api) : reject(new Error('The bot check did not load.'));
    };
    script.onerror = () => { loading = undefined; reject(new Error('The bot check could not load. Check your connection or content blocker.')); };
    document.head.append(script);
  });
  return loading;
}

// A fresh widget per call, rendered into a slot the caller owns: the assistant drawer and the
// contact dialog are both modal, so a widget attached to <body> would sit behind them, unclickable.
// Resolves undefined when no site key is configured, and the server then skips the check too.
export async function turnstileToken(slot: HTMLElement | null | undefined, action: 'session' | 'contact'): Promise<string | undefined> {
  if (!SITE_KEY) return undefined;
  if (!slot) throw new Error('The bot check has nowhere to render.');
  const api = await load();
  return new Promise<string>((resolve, reject) => {
    let id = '';
    const done = (finish: () => void) => { clearTimeout(timer); try { if (id) api.remove(id); } catch {} finish(); };
    // Long enough for a visitor who is shown the checkbox to notice it and click.
    const timer = setTimeout(() => done(() => reject(new Error('The bot check timed out. Please try again.'))), 90_000);
    id = api.render(slot, {
      sitekey: SITE_KEY,
      action,
      theme: 'dark',
      appearance: 'interaction-only',
      retry: 'never',
      callback: (token: string) => done(() => resolve(token)),
      'error-callback': () => { done(() => reject(new Error('The bot check failed. Reload the page and try again.'))); return true; },
      'expired-callback': () => done(() => reject(new Error('The bot check expired. Please try again.'))),
      'timeout-callback': () => done(() => reject(new Error('The bot check timed out. Please try again.'))),
    });
  });
}
