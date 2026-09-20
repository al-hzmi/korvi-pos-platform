import type { JSX } from 'react';
import { cn } from '../lib/cn.js';

export type KorviMarkSize = 'sm' | 'md' | 'lg';

const MARK_SIZE: Record<KorviMarkSize, string> = {
  sm: 'w-24',
  md: 'w-32',
  lg: 'w-40',
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

/**
 * Approved Korvi wordmark.
 *
 * The image asset is derived from the user-approved source artwork without
 * redrawing its geometry. It is intentionally kept out of fiscal document
 * headers, where the merchant — not the software vendor — is the issuer.
 */
export function KorviMark({ size = 'md', suffix, className }: KorviMarkProps): JSX.Element {
  return (
    <span dir="ltr" className={cn('inline-flex items-center gap-2', className)}>
      <img
        src="/brand/korvi-logo.webp"
        alt="Korvi"
        className={cn('block h-auto max-w-full shrink-0', MARK_SIZE[size])}
      />
      {suffix === undefined ? null : (
        <span
          className={cn(
            'bidi-isolate font-semibold uppercase tracking-[0.16em] text-muted-foreground',
            SUFFIX_SIZE[size],
          )}
        >
          {suffix}
        </span>
      )}
    </span>
  );
}
