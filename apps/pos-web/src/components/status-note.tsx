import { cn } from '@korvi/ui';
import type { JSX, ReactNode } from 'react';

/**
 * An operational message.
 *
 * The tone is carried by a word as well as by a colour. A cashier who does not
 * distinguish red from amber still has to be able to tell "لم تكتمل" from
 * "تنبيه", and WCAG 1.4.1 says the same thing more formally
 * (KORVI-DESIGN-SYSTEM.md §7.3).
 */
export type NoteTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

const TONE: Record<NoteTone, { readonly box: string; readonly label: string }> = {
  neutral: { box: 'bg-muted text-muted-foreground ring-border', label: 'ملاحظة' },
  info: { box: 'bg-primary/10 text-primary ring-primary/30', label: 'معلومة' },
  warning: { box: 'bg-warning/10 text-warning ring-warning/30', label: 'تنبيه' },
  danger: { box: 'bg-destructive/10 text-destructive ring-destructive/30', label: 'لم تكتمل' },
  success: { box: 'bg-success/10 text-success ring-success/30', label: 'تمّت' },
};

export interface StatusNoteProps {
  readonly tone: NoteTone;
  readonly children: ReactNode;
  readonly live?: boolean;
  readonly className?: string;
}

export function StatusNote({
  tone,
  children,
  live = false,
  className,
}: StatusNoteProps): JSX.Element {
  const style = TONE[tone];
  return (
    <p
      className={cn(
        'flex items-start gap-2 rounded-md px-3 py-2 text-sm ring-1 ring-inset',
        style.box,
        className,
      )}
      {...(live ? { role: 'status', 'aria-live': 'polite' } : {})}
    >
      <span className="shrink-0 font-semibold">{style.label}:</span>
      <span>{children}</span>
    </p>
  );
}
