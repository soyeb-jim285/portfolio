// Cloudflare Turnstile, checked where a visitor starts something that costs money or sends mail:
// a new conversation and a direct contact message. Everything later in a conversation rides on the
// session that passed it, so a visitor sees at most one check per conversation.
export type Verdict = 'pass' | 'fail' | 'unavailable';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Cloudflare's published test secrets answer for a dummy page (hostname example.com, empty action), so
// the hostname and action checks only apply to a real secret.
const isTestSecret = (secret: string) => /^[123]x0{31}AA$/.test(secret);

export async function verifyTurnstile(secret: string, token: string | undefined, ip: string | undefined, expected: { action: string; hostname: string }): Promise<Verdict> {
  // No secret means the check is switched off (local development, tests, a deploy without keys yet).
  if (!secret) return 'pass';
  // Cloudflare caps tokens at 2048 characters; anything missing or longer is not a token.
  if (!token || token.length > 2048) return 'fail';
  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== 'unknown') body.set('remoteip', ip);
  try {
    const response = await fetch(SITEVERIFY, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return 'unavailable';
    const result = await response.json() as { success?: boolean; action?: string; hostname?: string };
    // Tokens are single use and expire after five minutes; Cloudflare rejects replays itself.
    if (result.success !== true) return 'fail';
    if (isTestSecret(secret)) return 'pass';
    // A token minted for the other form, or on a page that is not this site, is not accepted here.
    return result.action === expected.action && result.hostname === expected.hostname ? 'pass' : 'fail';
  } catch {
    // Fail closed: an outage at Cloudflare must not become a way around the check.
    return 'unavailable';
  }
}
