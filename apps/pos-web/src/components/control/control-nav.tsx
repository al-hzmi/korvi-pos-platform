'use client';

import { cn } from '@korvi/ui';
import type { JSX } from 'react';

/**
 * The shape of Korvi, stated once.
 *
 * Everything a merchant will eventually manage is named here, and the parts
 * that are not built say so. Built sections can still be unavailable to this
 * principal; that is a UI courtesy only, while the API remains the authority.
 */
export type ControlSection = 'home' | 'products' | 'inventory' | 'branches' | 'staff' | 'settings';

export interface ControlEntry {
  readonly key: string;
  readonly label: string;
  readonly section: ControlSection | null;
  readonly permission?: string;
}

export const CONTROL_ENTRIES: readonly ControlEntry[] = [
  { key: 'home', label: 'الرئيسية', section: 'home', permission: 'report.read' },
  { key: 'sales', label: 'المبيعات', section: null },
  { key: 'products', label: 'المنتجات', section: 'products', permission: 'product.read' },
  { key: 'inventory', label: 'المخزون', section: 'inventory', permission: 'inventory.read' },
  { key: 'customers', label: 'العملاء', section: null },
  {
    key: 'branches',
    label: 'الفروع والصناديق',
    section: 'branches',
    permission: 'settings.manage',
  },
  { key: 'staff', label: 'الموظفون والصلاحيات', section: 'staff', permission: 'users.manage' },
  { key: 'reports', label: 'التقارير', section: null },
  { key: 'settings', label: 'الإعدادات', section: 'settings', permission: 'settings.manage' },
  { key: 'zatca', label: 'ZATCA', section: null },
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
  readonly onSelect: (section: ControlSection) => void;
  readonly permissions?: readonly string[];
  /** Keeps an ambiguous stock command mounted until its identity is resolved. */
  readonly locked?: boolean;
}

export function ControlNav({
  active,
  onSelect,
  permissions = [],
  locked = false,
}: ControlNavProps): JSX.Element {
  return (
    <nav aria-label="أقسام لوحة التحكم" className="flex flex-col gap-1">
      {CONTROL_ENTRIES.map((entry) => {
        const built = entry.section !== null;
        const authorized =
          built && entry.permission !== undefined && permissions.includes(entry.permission);
        const navigationLocked = locked && authorized && entry.section !== active;
        const badge = !built
          ? 'قريباً'
          : !authorized
            ? 'غير مصرح'
            : navigationLocked
              ? 'عملية معلقة'
              : null;

        return (
          <button
            key={entry.key}
            type="button"
            disabled={!authorized || navigationLocked}
            aria-current={authorized && entry.section === active ? 'page' : undefined}
            onClick={() => {
              if (authorized && !navigationLocked && entry.section !== null)
                onSelect(entry.section);
            }}
            className={cn(
              'flex h-touch items-center justify-between rounded-md px-3 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              authorized && !navigationLocked
                ? 'text-foreground hover:bg-accent'
                : 'cursor-not-allowed text-muted-foreground',
              authorized && entry.section === active
                ? 'bg-accent font-semibold text-accent-foreground'
                : '',
            )}
          >
            <span>{entry.label}</span>
            {badge === null ? null : (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
