export type ControlSection =
  | 'home'
  | 'products'
  | 'inventory'
  | 'purchasing'
  | 'branches'
  | 'staff'
  | 'settings';

export const CONTROL_SECTION_HREFS: Readonly<Record<ControlSection, string>> = {
  home: '/control',
  products: '/control/products',
  inventory: '/control/inventory',
  purchasing: '/control/purchasing',
  branches: '/control/branches',
  staff: '/control/staff',
  settings: '/control/settings',
};

const CONTROL_SECTION_BY_SLUG: Readonly<Record<string, ControlSection>> = {
  products: 'products',
  inventory: 'inventory',
  purchasing: 'purchasing',
  branches: 'branches',
  staff: 'staff',
  settings: 'settings',
};

export function controlSectionHref(section: ControlSection): string {
  return CONTROL_SECTION_HREFS[section];
}

export function controlSectionFromSlug(slug: string): ControlSection | null {
  return CONTROL_SECTION_BY_SLUG[slug] ?? null;
}
