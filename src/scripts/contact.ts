// Contact dialog behaviour: open from any [data-contact], validate, POST JSON, show state.
export function initContact() {
  const dialog = document.getElementById('contact-dialog') as HTMLDialogElement | null;
  if (!dialog || dialog.dataset.bound) return;
  dialog.dataset.bound = '1';
  const form = dialog.querySelector('form')!;
  const status = dialog.querySelector<HTMLElement>('[data-cd-status]')!;
  const send = dialog.querySelector<HTMLButtonElement>('[data-cd-send]')!;
  const label = send.querySelector<HTMLElement>('[data-label]')!;
  const endpoint = dialog.dataset.endpoint || '';
  const email = dialog.dataset.email || '';

  // One document-level opener for the whole session; it looks the dialog up at click
  // time because view transitions replace the element on every navigation.
  if (!(document as any).__cdOpener) {
    (document as any).__cdOpener = true;
    document.addEventListener('click', event => {
      const trigger = (event.target as HTMLElement).closest('[data-contact]');
      if (!trigger) return;
      const current = document.getElementById('contact-dialog') as HTMLDialogElement | null;
      if (!current || !current.isConnected) return;
      event.preventDefault();
      current.showModal();
      current.querySelector<HTMLInputElement>('input[name=name]')?.focus();
    });
  }
  dialog.querySelector('[data-cd-close]')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }); // backdrop click

  const setError = (name: string, message: string) => {
    const slot = dialog.querySelector<HTMLElement>(`[data-err-for="${name}"]`);
    const input = form.elements.namedItem(name) as HTMLInputElement;
    if (slot) slot.textContent = message;
    input?.setAttribute('aria-invalid', message ? 'true' : 'false');
  };
  const fields = () => form.elements as any;
  const validate = () => {
    let ok = true;
    const values = fields();
    setError('name', ''); setError('email', ''); setError('message', '');
    if (!values.name.value.trim()) { setError('name', 'Your name, please.'); ok = false; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email.value.trim())) { setError('email', 'That email does not look right.'); ok = false; }
    if (values.message.value.trim().length < 10) { setError('message', 'A few more words.'); ok = false; }
    return ok;
  };

  // Used when no backend is configured and when the server reports no mail provider.
  const handOffToMailClient = (data: { name: string; email: string; message: string }) => {
    location.href = `mailto:${email}?subject=${encodeURIComponent(`Hello from ${data.name}`)}&body=${encodeURIComponent(`${data.message}\n\n${data.email}`)}`;
    status.textContent = 'Opening your mail app.';
  };
  const reset = () => {
    dialog.classList.remove('is-sending');
    send.disabled = false;
    label.textContent = 'Send';
  };

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!validate()) return;
    const values = fields();
    const data = { name: values.name.value.trim(), email: values.email.value.trim(), message: values.message.value.trim(), _gotcha: values._gotcha.value };

    if (!endpoint || endpoint.includes('REPLACE')) return handOffToMailClient(data);
    send.disabled = true; label.textContent = 'Sending'; status.textContent = ''; dialog.classList.add('is-sending');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
      });
      // 503 means the server has no mail provider configured.
      if (response.status === 503) { handOffToMailClient(data); reset(); return; }
      if (!response.ok) throw new Error(String(response.status));
      dialog.classList.remove('is-sending'); dialog.classList.add('is-sent');
      label.textContent = 'Sent'; status.textContent = `Got it. I will reply to ${data.email}.`;
      form.reset();
      setTimeout(() => { dialog.close(); dialog.classList.remove('is-sent'); reset(); status.textContent = ''; }, 2200);
    } catch {
      dialog.classList.remove('is-sending'); dialog.classList.add('is-error');
      label.textContent = 'Retry'; send.disabled = false;
      status.textContent = `Could not send. Email ${email} directly.`;
    }
  });
}
