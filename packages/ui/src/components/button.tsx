import type { ButtonHTMLAttributes, JSX } from 'react';
import { cn } from '../lib/cn.js';

/**
 * The five variants from KORVI-DESIGN-SYSTEM.md §7.3, at POS touch sizes.
 *
 * Heights differ from the ERP deliberately (§12): 40px works with a mouse and
 * mis-taps with a thumb, so `md` is 44px here and `lg` is 48px for payment and
 * keypad keys.
 *
 * `loading` keeps the button disabled. The comment in the ERP source is worth
 * repeating: the commonest way to post an invoice twice is to press Post twice
 * before the first request returns. Here that is a double charge.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-touch px-4 text-sm',
  lg: 'h-touch-lg px-6 text-base',
  icon: 'h-touch w-touch',
};

const BASE =
  'inline-flex select-none items-center justify-center gap-2 rounded-md font-medium ' +
  'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
  'disabled:pointer-events-none disabled:opacity-50';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled === true || loading}
      aria-busy={loading}
      className={cn(BASE, VARIANT[variant], SIZE[size], className)}
    >
      {children}
    </button>
  );
}
