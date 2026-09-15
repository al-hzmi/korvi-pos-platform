'use client';

import { cn } from '@korvi/ui';
import { controlSectionHref } from '../../lib/control-routes';
import type { JSX } from 'react';
import type { ControlSection } from '../../lib/control-routes';

export type { ControlSection } from '../../lib/control-routes';

/**
 * The shape of Korvi, stated once.
 *
 * Built merchant sections own real URLs. Entries without an implemented
 * product surface stay explicitly unavailable until their backend and UI
 * authority are complete; they are never represented as finished.
 */
export interface ControlEntry {
  readonly key: string;
  readonly label: string;
  readonly section: ControlSection | null;
  readonly permission?: string;
}

export const CONTROL_ENTRIES: readonly ControlEntry[] = [
  { key: 'home', label: 'الرئيسية', section: 'home', permission: 'report.read' },
  { key: 'sales', label: 'المبيعات', section: 'sales', permission: 'report.read' },
  { key: 'products', label: 'المنتجات', section: 'products', permission: 'product.read' },
  { key: 'inventory', label: 'المخزون', section: 'inventory', permission: 'inventory.read' },
  {
    key: 'purchasing',
    label: 'المشتريات',
    section: 'purchasing',
    permission: 'purchasing.read',
  },
  { key: 'customers', label: 'العملاء', section: 'customers', permission: 'customer.read' },
  {
    key: 'branches',
    label: 'الفروع والصناديق',
    section: 'branches',
    permission: 'settings.manage',
  },
  { key: 'staff', label: 'الموظفون والصلاحيات', section: 'staff', permission: 'users.manage' },
  { key: 'reports', label: 'التقارير', section: 'reports', permission: 'report.read' },
  { key: 'settings', label: 'الإعدادات', section: 'settings', permission: 'settings.manage' },
  { key: 'zatca', label: 'ZATCA', section: 'zatca', permission: 'zatca.manage' },
];

export function canAccessControlSection(
  section: ControlSection,
  permissions: readonly string[],
): boolean {
  const entry = CONTROL_ENTRIES.find((candidate) => candidate.section === section);
  return entry?.permission !== undefined && permissions.includes(entry.permission);
}

export function firstAuthorizedSection(permissions: readonly string[]): ControlSection | null {
  const entry = CONTROL_ENTRIES.find(
    (candidate) =>
      candidate.section !== null &&
      candidate.permission !== undefined &&
      permissions.includes(candidate.permission),
  );
  return entry?.section ?? null;
}

export function canOpenControlCentre(permissions: readonly string[]): boolean {
  return firstAuthorizedSection(permissions) !== null;
}

export interface ControlNavProps {
  readonly active: ControlSection;
  readonly permissions?: readonly string[];
  /** Keeps an ambiguous stock or purchasing command mounted until its identity is resolved. */
  readonly locked?: boolean;
  /** @deprecated Route navigation is now URL-authoritative. Kept temporarily for caller compatibility. */
  readonly onSelect?: (section: ControlSection) => void;
}

export function ControlNav({
  active,
  permissions = [],
  locked = false,
}: ControlNavProps): JSX.Element {
  return (
    <nav
      aria-label="أقسام لوحة التحكم"
      className="flex gap-1 overflow-x-auto overscroll-x-contain lg:flex-col lg:overflow-visible"
    >
      {CONTROL_ENTRIES.map((entry) => {
        const built = entry.section !== null;
        const authorized =
          built && entry.permission !== undefined && permissions.includes(entry.permission);
        const navigationLocked = locked && authorized;
        const badge = !built
          ? 'غير مكتمل'
          : !authorized
            ? 'غير مصرح'
            : navigationLocked && entry.section !== active
              ? 'عملية معلقة'
              : null;
        const className = cn(
          'h-touch shrink-0 items-center justify-between gap-2 rounded-md px-3 text-sm transition-colors lg:w-full',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          authorized ? 'flex' : 'hidden lg:flex',
          authorized && !navigationLocked
            ? 'text-foreground hover:bg-accent'
            : 'cursor-not-allowed text-muted-foreground',
          authorized && entry.section === active
            ? 'bg-accent font-semibold text-accent-foreground'
            : '',
        );
        const content = (
          <>
            <span>{entry.label}</span>
            {badge === null ? null : (
              <span className="hidden rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground lg:inline-flex">
                {badge}
              </span>
            )}
          </>
        );

        if (authorized && !navigationLocked && entry.section !== null) {
          return (
            <a
              key={entry.key}
              href={controlSectionHref(entry.section)}
              aria-current={entry.section === active ? 'page' : undefined}
              className={className}
            >
              {content}
            </a>
          );
        }

        return (
          <span
            key={entry.key}
            aria-current={authorized && entry.section === active ? 'page' : undefined}
            aria-disabled="true"
            className={className}
          >
            {content}
          </span>
        );
      })}
    </nav>
  );
}
