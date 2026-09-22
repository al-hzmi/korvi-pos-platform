'use client';

import { cn } from '@korvi/ui';
import { controlSectionHref } from '../../lib/control-routes';
import type { JSX } from 'react';
import type { ControlSection } from '../../lib/control-routes';

export type { ControlSection } from '../../lib/control-routes';
export { canOpenControlCentre } from '../../lib/control-access';

/**
 * The shape of Korvi, stated once.
 *
 * Navigation is a working set, not a permissions report: sections that the
 * current server-backed principal cannot open stay out of the primary nav.
 * A direct URL still resolves through the permission boundary in ControlApp.
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
  {
    key: 'migration',
    label: 'الترحيل والاستيراد',
    section: 'migration',
    permission: 'settings.manage',
  },
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
  const authorizedEntries = CONTROL_ENTRIES.filter(
    (entry) => entry.permission !== undefined && permissions.includes(entry.permission),
  );

  return (
    <nav
      aria-label="أقسام لوحة التحكم"
      className="flex gap-1.5 overflow-x-auto overscroll-x-contain pb-1 lg:flex-col lg:overflow-visible lg:pb-0"
    >
      {authorizedEntries.map((entry) => {
        if (entry.section === null) return null;

        const navigationLocked = locked && entry.section !== active;
        const isActive = entry.section === active;
        let stateClassName = 'text-foreground hover:bg-accent hover:text-accent-foreground';

        if (isActive) {
          stateClassName = 'bg-primary text-primary-foreground shadow-sm';
        }
        if (navigationLocked) {
          stateClassName = 'cursor-not-allowed text-muted-foreground';
        }

        const className = cn(
          'flex h-touch shrink-0 items-center justify-between gap-3 rounded-lg px-3.5 text-sm font-medium transition-colors lg:w-full',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          stateClassName,
        );

        if (!navigationLocked) {
          return (
            <a
              key={entry.key}
              href={controlSectionHref(entry.section)}
              aria-current={isActive ? 'page' : undefined}
              className={className}
            >
              <span>{entry.label}</span>
              {isActive ? (
                <span
                  className="size-1.5 rounded-full bg-primary-foreground/80"
                  aria-hidden="true"
                />
              ) : null}
            </a>
          );
        }

        return (
          <span key={entry.key} aria-disabled="true" className={className}>
            <span>{entry.label}</span>
            <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
              عملية معلقة
            </span>
          </span>
        );
      })}
    </nav>
  );
}
