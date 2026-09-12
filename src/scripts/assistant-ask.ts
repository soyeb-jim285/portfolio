// Any element can open the assistant: `data-assistant-ask="question"` sends a question,
// `data-assistant-repo="name"` opens the code browser on that repository.
export function initAssistantAsk() {
  if ((document as any).__assistantAsk) return;
  (document as any).__assistantAsk = true;
  document.addEventListener('click', event => {
    const trigger = (event.target as HTMLElement).closest<HTMLElement>('[data-assistant-ask], [data-assistant-repo]');
    if (!trigger) return;
    event.preventDefault();
    dispatchEvent(new CustomEvent('assistant:ask', {
      detail: {
        question: trigger.dataset.assistantAsk || undefined,
        repo: trigger.dataset.assistantRepo || undefined,
        path: trigger.dataset.assistantPath || undefined,
      },
    }));
  });
}
