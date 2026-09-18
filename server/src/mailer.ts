// Resend over plain fetch: one endpoint, no SDK. Delivery is "accepted by the provider",
// which is not the same as "in the inbox", and the wording everywhere says so.
export type Mailer = { configured: boolean; recipientLabel: string; send(message: { name: string; email: string; body: string }): Promise<string> };
export class AmbiguousDeliveryError extends Error {}

export function createMailer(
  config: { RESEND_API_KEY?: string; CONTACT_FROM?: string; CONTACT_TO?: string; CONTACT_LABEL: string },
  fetchImpl: typeof fetch = fetch,
): Mailer {
  const configured = Boolean(config.RESEND_API_KEY && config.CONTACT_FROM && config.CONTACT_TO);
  return {
    configured,
    recipientLabel: config.CONTACT_LABEL,
    async send({ name, email, body }) {
      if (!configured) throw new Error('Email delivery is not configured');
      let response: Response;
      try { response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: config.CONTACT_FROM,
          to: [config.CONTACT_TO],
          // The visitor never sends as themselves; replying to the mail reaches them.
          reply_to: email,
          subject: `Portfolio message from ${name}`,
          text: `${body}\n\n—\nFrom: ${name} <${email}>\nSent through the assistant on soyebjim.me.`,
        }),
        signal: AbortSignal.timeout(15000),
      }); } catch { throw new AmbiguousDeliveryError('Email provider did not confirm delivery'); }
      if (response.status >= 500) throw new AmbiguousDeliveryError(`Email provider error (${response.status})`);
      if (!response.ok) throw new Error(`Email provider rejected the message (${response.status})`);
      const result = await response.json().catch(() => ({}));
      return typeof result?.id === 'string' ? result.id : '';
    },
  };
}
