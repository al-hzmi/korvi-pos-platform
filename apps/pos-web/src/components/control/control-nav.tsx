'use client';

import { cn } from '@korvi/ui';
import type { JSX } from 'react';

/**
 * The shape of Korvi, stated once.
 *
 * Everything a merchant will eventually manage is named here, and the parts
 * that are not built say so. A navigation entry that opens an empty page
 * teaches a merchant not to trust the navigation; one that says "قريباً" tells
 * them the truth and costs nothing.
 */
export type ControlSection = 'home' | 'products';

export interface ControlEntry {
  readonly key: string;
  readonly label: string;
  readonly section: ControlSection | null;
}

export const CONTROL_ENTRIES: readonly ControlEntry[] = [
  { key: 'home', label: 'الرئيسية', section: 'home' },
  { key: 'sales', label: 'المبيعات', section: null },
  { key: 'products', label: 'المنتجات', section: 'products' },
  { key: 'inventory', label: 'المخزون', section: null },
  { key: 'customers', label: 'العملاء', section: null },
  { key: 'branches', label: 'الفروع والصناديق', section: null },
  { key: 'staff', label: 'الموظفون والصلاحيات', section: null },
  { key: 'reports', label: 'التقارير', section: null },
  { key: 'settings', label: 'الإعدادات', section: null },
  { key: 'zatca', label: 'ZATCA', section: null },
];

export interface ControlNavProps {
  readonly active: ControlSection;
  readonly onSelect: (section: ControlSection) => void;
}

export function ControlNav({ active, onSelect }: ControlNavProps): JSX.Element {
  return (
    <nav aria-label="أقسام لوحة التحكم" className="flex flex-col gap-1">
      {CONTROL_ENTRIES.map((entry) => {
        const available = entry.section !== null;
        return (
          <button
            key={entry.key}
            type="button"
            disabled={!available}
            aria-current={available && entry.section === active ? 'page' : undefined}
            onClick={() => {
              if (entry.section !== null) onSelect(entry.section);
            }}
            className={cn(
              'flex h-touch items-center justify-between rounded-md px-3 text-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              available
                ? 'text-foreground hover:bg-accent'
                : 'cursor-not-allowed text-muted-foreground',
              available && entry.section === active
                ? 'bg-accent font-semibold text-accent-foreground'
                : '',
            )}
          >
            <span>{entry.label}</span>
            {available ? null : (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                قريباً
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
