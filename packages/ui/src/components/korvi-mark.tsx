import type { JSX } from 'react';
import { cn } from '../lib/cn.js';

/**
 * The Korvi wordmark — text, not an image.
 *
 * Documented reasoning (KORVI-DESIGN-SYSTEM.md §8): there is no file to lose,
 * no second copy to keep in step with the theme, and it prints — a bitmap at
 * screen resolution comes out of a thermal head as a grey smudge.
 *
 * The suffix sits at the start of the lockup and the name at the end, matching
 * the Korvi ERP lockup exactly; only the suffix string differs.
 *
 * Placement rule: this must never appear in a tax invoice header. That header
 * identifies who issued the invoice, and putting the software vendor's name
 * there tells an auditor Korvi sold the goods. Footer only, as
 * "صُدرت عبر Korvi".
 */
export type KorviMarkSize = 'sm' | 'md' | 'lg';

const NAME_SIZE: Record<KorviMarkSize, string> = {
  sm: 'text-lg',
  md: 'text-2xl',
  lg: 'text-3xl',
};

const SUFFIX_SIZE: Record<KorviMarkSize, string> = {
  sm: 'text-[9px]',
  md: 'text-[10px]',
  lg: 'text-xs',
};

export interface KorviMarkProps {
  readonly size?: KorviMarkSize;
  readonly suffix?: string;
  readonly className?: string;
}

export function KorviMark({ size = 'md', suffix = 'POS', className }: KorviMarkProps): JSX.Element {
  return (
    <span
      dir="ltr"
      className={cn('inline-flex items-baseline gap-2', className)}
      aria-label={`Korvi ${suffix}`}
    >
      <span
        aria-hidden="true"
        className={cn(
          'bidi-isolate font-semibold uppercase tracking-[0.2em] text-muted-foreground',
          SUFFIX_SIZE[size],
        )}
      >
        {suffix}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'bidi-isolate font-extrabold tracking-wider text-brand dark:text-brand-on-dark',
          NAME_SIZE[size],
        )}
      >
        Korvi
      </span>
    </span>
  );
}
