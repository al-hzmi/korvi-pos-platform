'use client';

import { cn } from '@korvi/ui';
import type { JSX, MouseEvent } from 'react';

/**
 * The shape of Korvi's merchant control centre, stated once.
 *
 * A section being named here does not make it implemented. `section: null`
 * remains an explicit product gap. Built sections still require server-backed
 * permissions; hiding or disabling navigation is only a UX courtesy.
 */
export type ControlSection =
  'home' | 'products' | 'inventory' | 'purchasing' | 'branches' | 'staff' | 'settings';

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
  {
    key: 'purchasing',
    label: 'المشتريات',
    section: 'purchasing',
    permission: 'purchasing.read',
  },
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

const CONTROL_SECTIONS = new Set<ControlSection>([
  'home',
  'products',
  'inventory',
  'purchasing',
  'branches',
  'staff',
  'settings',
]);

export function isControlSection(value: string): value is ControlSection {
  return CONTROL_SECTIONS.has(value as ControlSection);
}

/** Stable, bookmarkable route for every built merchant surface. */
export function controlSectionHref(section: ControlSection): string {
  return `/control/${section}`;
}

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

export type ControlRouteResolution =
  | { readonly kind: 'section'; readonly section: ControlSection }
  | { readonly kind: 'forbidden'; readonly section: ControlSection }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'none' };

/**
 * Resolve the URL to a merchant surface without silently changing explicit
 * deep links. `/control` is the only entry route allowed to choose the first
 * authorized section; a forbidden or unknown explicit URL stays forbidden or
 * unknown so refresh/back/forward never lands the user somewhere else.
 */
export function resolveControlRoute(
  requestedSection: string | null,
  permissions: readonly string[],
): ControlRouteResolution {
  if (requestedSection === null) {
    const fallback = firstAuthorizedSection(permissions);
    return fallback === null ? { kind: 'none' } : { kind: 'section', section: fallback };
  }

  if (!isControlSection(requestedSection)) return { kind: 'invalid' };
  if (!canAccessControlSection(requestedSection, permissions)) {
    return { kind: 'forbidden', section: requestedSection };
  }
  return { kind: 'section', section: requestedSection };
}

export interface ControlNavProps {
  readonly active: ControlSection | null;
  readonly onSelect?: (section: ControlSection) => void;
  readonly permissions?: readonly string[];
  /** Keeps an ambiguous stock or purchasing command mounted until its identity is resolved. */
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
        const className = cn(
          'flex h-touch items-center justify-between rounded-md px-3 text-sm transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          authorized && !navigationLocked
            ? 'text-foreground hover:bg-accent'
            : 'cursor-not-allowed text-muted-foreground',
          authorized && entry.section === active
            ? 'bg-accent font-semibold text-accent-foreground'
            : '',
        );
        const contents = (
          <>
            <span>{entry.label}</span>
            {badge === null ? null : (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {badge}
              </span>
            )}
          </>
        );

        if (!authorized || navigationLocked || entry.section === null) {
          return (
            <span key={entry.key} aria-disabled="true" className={className}>
              {contents}
            </span>
          );
        }

        const section = entry.section;
        return (
          <a
            key={entry.key}
            href={controlSectionHref(section)}
            aria-current={section === active ? 'page' : undefined}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              if (onSelect === undefined) return;
              event.preventDefault();
              onSelect(section);
            }}
            className={className}
          >
            {contents}
          </a>
        );
      })}
    </nav>
  );
}
