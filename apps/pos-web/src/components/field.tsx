import { cn } from '@korvi/ui';
import type { InputHTMLAttributes, JSX, ReactNode, Ref } from 'react';

/**
 * A labelled input.
 *
 * The label is a real <label for>, not a placeholder. A placeholder disappears
 * the moment somebody types, which is the moment they most need to know what
 * the field was — and a screen reader never sees it as a name at all.
 *
 * `h-touch` rather than the ERP's h-10: 40px is below the 44px minimum and
 * mis-taps with a thumb (§3.4).
 */
export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly id: string;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly invalid?: boolean;
  readonly trailing?: ReactNode;
  readonly inputRef?: Ref<HTMLInputElement>;
}

export function Field({
  id,
  label,
  hint,
  invalid = false,
  trailing,
  inputRef,
  className,
  ...rest
}: FieldProps): JSX.Element {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <div className="relative flex items-center">
        <input
          {...rest}
          id={id}
          ref={inputRef}
          aria-invalid={invalid}
          aria-describedby={hintId}
          className={cn(
            'h-touch w-full rounded-md border border-input bg-background px-3 text-base',
            'text-foreground placeholder:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            'disabled:cursor-not-allowed disabled:opacity-50',
            invalid && 'border-destructive',
            trailing !== undefined && 'pe-12',
            className,
          )}
        />
        {trailing !== undefined ? (
          <span className="absolute end-1 flex items-center">{trailing}</span>
        ) : null}
      </div>
      {hint === undefined ? null : (
        <span id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  );
}
