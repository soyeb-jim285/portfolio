// The assistant's panel, on a native <dialog>: modal on mobile, a non-modal side sheet otherwise.
import { useEffect, useRef, type ComponentProps } from 'react';

export function SheetContent({ open, modal, container, onDismiss, onShown, className = '', children, ...props }: ComponentProps<'dialog'> & {
  open: boolean; modal: boolean; container: HTMLElement | null; onDismiss: () => void; onShown: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const sync = () => {
      const element = dialog.current;
      if (!element) return;
      if (element.open) element.close();
      if (!open) return;
      if (modal) element.showModal(); else element.show();
      onShown();
    };
    sync();
    if (!modal) return;
    // Astro re-inserts the persisted panel on navigation, which drops a modal out of the top layer.
    document.addEventListener('astro:after-swap', sync);
    return () => document.removeEventListener('astro:after-swap', sync);
  }, [open, modal, container]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onDismiss(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  if (!container) return null;
  // The content stays mounted while closed and CSS hides it: reopening shows the rendered
  // conversation as it was, instead of parsing and highlighting every answer again.
  return <dialog ref={dialog} data-state={open ? 'open' : 'closed'} className={`assistant-panel ${className}`}
    onCancel={event => event.preventDefault()}
    onClick={event => {
      // A click on the backdrop lands on the dialog itself, above the drawer's top edge.
      if (modal && event.target === event.currentTarget && event.clientY < event.currentTarget.getBoundingClientRect().top) onDismiss();
    }} {...props}>{children}</dialog>;
}
