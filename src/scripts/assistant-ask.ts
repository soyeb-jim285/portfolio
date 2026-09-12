// Any element can open the assistant: `data-assistant-ask="question"` sends that question.
export function initAssistantAsk() {
  if ((document as any).__assistantAsk) return;
  (document as any).__assistantAsk = true;
  document.addEventListener('click', event => {
    const trigger = (event.target as HTMLElement).closest<HTMLElement>('[data-assistant-ask]');
    if (!trigger) return;
    event.preventDefault();
    dispatchEvent(new CustomEvent('assistant:ask', { detail: { question: trigger.dataset.assistantAsk || undefined } }));
  });
}
