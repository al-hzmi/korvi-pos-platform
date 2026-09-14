export type ControlSection =
  | 'home'
  | 'products'
  | 'inventory'
  | 'purchasing'
  | 'branches'
  | 'staff'
  | 'settings';

const SECTION_SLUGS = {
  products: 'products',
  inventory: 'inventory',
  purchasing: 'purchasing',
  branches: 'branches',
  staff: 'staff',
  settings: 'settings',
} as const satisfies Record<Exclude<ControlSection, 'home'>, string>;

export function controlSectionHref(section: ControlSection): string {
  if (section === 'home') return '/control';
  return `/control/${SECTION_SLUGS[section]}`;
}

export function controlSectionFromSlug(slug: string): ControlSection | null {
  for (const [section, candidate] of Object.entries(SECTION_SLUGS)) {
    if (candidate === slug) return section as Exclude<ControlSection, 'home'>;
  }
  return null;
}

export const CONTROL_SECTION_HREFS: Readonly<Record<ControlSection, string>> = {
  home: '/control',
  products: '/control/products',
  inventory: '/control/inventory',
  purchasing: '/control/purchasing',
  branches: '/control/branches',
  staff: '/control/staff',
  settings: '/control/settings',
};
