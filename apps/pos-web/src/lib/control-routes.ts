export const CONTROL_SECTION_HREFS = {
  home: '/control',
  products: '/control/products',
  inventory: '/control/inventory',
  purchasing: '/control/purchasing',
  branches: '/control/branches',
  staff: '/control/staff',
  settings: '/control/settings',
} as const;

export type ControlSection = keyof typeof CONTROL_SECTION_HREFS;

export function controlSectionHref(section: ControlSection): string {
  return CONTROL_SECTION_HREFS[section];
}

export function controlSectionFromSlug(slug: string): ControlSection | null {
  switch (slug) {
    case 'products':
    case 'inventory':
    case 'purchasing':
    case 'branches':
    case 'staff':
    case 'settings':
      return slug;
    default:
      return null;
  }
}
