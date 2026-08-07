import type { HTMLAttributes, JSX } from 'react';
import { cn } from '../lib/cn.js';

/**
 * The standard raised surface (§7.3).
 *
 * `rounded-lg` on the container, `rounded-md` on the controls inside it — the
 * inner element is always less round than its container, never the reverse.
 */
export function CardSurface({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      {...rest}
      className={cn(
        'rounded-lg border border-border bg-card text-card-foreground shadow-sm',
        className,
      )}
    >
      {children}
    </div>
  );
}
