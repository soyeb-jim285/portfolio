// Adapted from shadcn/ui Sheet (MIT): right-side only, native theme CSS,
// and a persistent portal container for Astro navigation.
import type { ComponentProps } from 'react';
import { Dialog as SheetPrimitive } from 'radix-ui';

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;
export const SheetTitle = SheetPrimitive.Title;
export const SheetDescription = SheetPrimitive.Description;

export function SheetContent({ container, className = '', children, ...props }: ComponentProps<typeof SheetPrimitive.Content> & {
  container: HTMLElement | null;
}) {
  if (!container) return null;
  // The content stays mounted while closed and CSS hides it: reopening shows the rendered
  // conversation as it was, instead of parsing and highlighting every answer again.
  return <SheetPrimitive.Portal container={container} forceMount>
    <SheetPrimitive.Overlay className="assistant-overlay" />
    <SheetPrimitive.Content data-slot="sheet-content" className={`assistant-panel ${className}`} forceMount {...props}>
      {children}
    </SheetPrimitive.Content>
  </SheetPrimitive.Portal>;
}
