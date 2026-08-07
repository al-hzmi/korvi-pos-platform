import type { JSX } from 'react';
import { cn } from '../lib/cn.js';

/**
 * Any figure a merchant reconciles.
 *
 * Takes a pre-formatted string rather than a number on purpose: formatting is
 * the domain's job (moneyToMajorString), and accepting a number here would
 * invite a float into the render path — the exact thing ADR-0002 forbids.
 *
 * `.numeric` supplies tabular figures and LTR isolation; see tokens.css.
 */
export interface NumericProps {
  readonly value: string;
  readonly className?: string;
  readonly title?: string;
}

export function Numeric({ value, className, title }: NumericProps): JSX.Element {
  return (
    <span className={cn('numeric font-numeric', className)} dir="ltr" title={title}>
      {value}
    </span>
  );
}

/**
 * A Latin run inside Arabic prose — document numbers, SKUs, barcodes.
 *
 * Without isolation the bidi algorithm reverses the segments of
 * "INV-2026-00001" and shows a document number that does not exist.
 */
export interface BidiIsolateProps {
  readonly children: string;
  readonly className?: string;
}

export function BidiIsolate({ children, className }: BidiIsolateProps): JSX.Element {
  return (
    <span className={cn('bidi-isolate', className)} dir="ltr">
      {children}
    </span>
  );
}
