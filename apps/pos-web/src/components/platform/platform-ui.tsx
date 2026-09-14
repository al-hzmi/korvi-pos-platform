'use client';

import { CardSurface, cn } from '@korvi/ui';
import type { JSX, ReactNode } from 'react';
import type { PlatformLifecycleStatus } from '../../lib/platform-api';

export const PLATFORM_INPUT =
  'h-11 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none ' +
  'placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export const PLATFORM_LABEL = 'mb-1.5 block text-xs font-medium text-muted-foreground';

const STATUS_STYLE: Record<PlatformLifecycleStatus, string> = {
  active: 'bg-primary/10 text-primary',
  provisioning: 'bg-secondary text-secondary-foreground',
  suspended: 'bg-destructive/10 text-destructive',
};

const STATUS_LABEL: Record<PlatformLifecycleStatus, string> = {
  active: 'نشطة',
  provisioning: 'قيد التجهيز',
  suspended: 'موقوفة',
};

export function PlatformStatusBadge({
  status,
}: {
  readonly status: PlatformLifecycleStatus;
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex min-h-7 items-center rounded-full px-2.5 text-xs font-semibold',
        STATUS_STYLE[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export function PlatformPageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-4 border-b border-border/70 pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <p className="mb-1 text-xs font-semibold tracking-wide text-primary">{eyebrow}</p>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {action === undefined ? null : <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function PlatformMetric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}): JSX.Element {
  return (
    <CardSurface className="p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className="mt-2 font-mono text-2xl font-semibold tabular-nums text-card-foreground"
        dir="ltr"
      >
        {value}
      </p>
      {detail === undefined ? null : (
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
      )}
    </CardSurface>
  );
}

export function PlatformEmpty({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}): JSX.Element {
  return (
    <CardSurface className="px-6 py-12 text-center">
      <p className="text-base font-semibold text-card-foreground">{title}</p>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">{description}</p>
    </CardSurface>
  );
}

export function PlatformNotice({
  tone = 'neutral',
  children,
}: {
  readonly tone?: 'neutral' | 'danger' | 'warning';
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      role="status"
      className={cn(
        'rounded-lg border px-4 py-3 text-sm leading-6',
        tone === 'danger' && 'border-destructive/30 bg-destructive/5 text-destructive',
        tone === 'warning' && 'border-border bg-secondary/70 text-secondary-foreground',
        tone === 'neutral' && 'border-border bg-muted/40 text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}

export function PlatformSkeletonRows(): JSX.Element {
  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-card"
      role="status"
      aria-label="جارٍ التحميل"
    >
      {[0, 1, 2, 3, 4].map((row) => (
        <div
          key={row}
          className="grid grid-cols-4 gap-4 border-b border-border/70 p-4 last:border-b-0"
        >
          <div className="h-4 animate-pulse rounded bg-muted" />
          <div className="h-4 animate-pulse rounded bg-muted" />
          <div className="h-4 animate-pulse rounded bg-muted" />
          <div className="h-4 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
