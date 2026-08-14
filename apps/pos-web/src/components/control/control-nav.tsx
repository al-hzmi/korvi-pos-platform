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
export type ControlSection = 'home' | 'products' | 'branches' | 'settings';

export interface ControlEntry {
  readonly key: string;
  readonly label: string;
  readonly section: ControlSection | null;
  readonly permission?: string;
}

export const CONTROL_ENTRIES: readonly ControlEntry[] = [
  { key: 'home', label: 'الرئيسية', section: 'home' },
  { key: 'sales', label: 'المبيعات', section: null },
  { key: 'products', label: 'المنتجات', section: 'products' },
  { key: 'inventory', label: 'المخزون', section: null },
  { key: 'customers', label: 'العملاء', section: null },
  { key: 'branches', label: 'الفروع والصناديق', section: 'branches', permission: 'settings.manage' },
  { key: 'staff', label: 'الموظفون والصلاحيات', section: null },
  { key: 'reports', label: 'التقارير', section: null },
  { key: 'settings', label: 'الإعدادات', section: 'settings', permission: 'settings.manage' },
  { key: 'zatca', label: 'ZATCA', section: null },
];

export interface ControlNavProps {
  readonly active: ControlSection;
  readonly onSelect: (section: ControlSection) => void;
  readonly permissions?: readonly string[];
}

export function ControlNav({
  active,
  onSelect,
  permissions = [],
}: ControlNavProps): JSX.Element {
  return (
    <nav aria-label="أقسام لوحة التحكم" className="flex flex-col gap-1">
      {CONTROL_ENTRIES.map((entry) => {
        const built = entry.section !== null;
        const authorized =
          built && (entry.permission === undefined || permissions.includes(entry.permission));
        const badge = !built ? 'قريباً' : authorized ? null : 'غير مصرح';

        return (
          <button
            key={entry.key}
            type="button"
            disabled={!authorized}
            aria-current={authorized && entry.section === active ? 'page' : undefined}
            onClick={() => {
              if (authorized && entry.section !== null) onSelect(entry.section);
            }}
            className={cn(
              'flex h-touch items-center justify-between rounded-md px-3 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              authorized
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
