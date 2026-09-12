// Adapted from shadcn/ui Button (MIT); utility variants replaced with the site's CSS.
import type { ComponentProps } from 'react';
import { Slot } from 'radix-ui';

export function Button({ className = '', variant = 'outline', size = 'default', asChild = false, ...props }: ComponentProps<'button'> & {
  variant?: 'default' | 'outline' | 'ghost'; size?: 'default' | 'icon'; asChild?: boolean;
}) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" data-variant={variant} data-size={size} className={`chat-button ${className}`} {...props} />;
}
