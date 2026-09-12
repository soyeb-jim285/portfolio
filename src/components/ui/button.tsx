// Adapted from shadcn/ui Button (MIT); utility variants replaced with the site's CSS.
import type { ComponentProps } from 'react';

export function Button({ className = '', variant = 'outline', size = 'default', ...props }: ComponentProps<'button'> & {
  variant?: 'default' | 'outline' | 'ghost'; size?: 'default' | 'icon';
}) {
  return <button data-slot="button" data-variant={variant} data-size={size} className={`chat-button ${className}`} {...props} />;
}
