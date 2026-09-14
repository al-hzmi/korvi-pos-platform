import { describe, expect, it } from 'vitest';
import {
  CONTROL_SECTION_HREFS,
  controlSectionFromSlug,
  controlSectionHref,
  type ControlSection,
} from '../lib/control-routes';

const SECTIONS: readonly ControlSection[] = [
  'home',
  'sales',
  'products',
  'inventory',
  'purchasing',
  'customers',
  'branches',
  'staff',
  'reports',
  'settings',
];

describe('merchant control route authority', () => {
  it('assigns one stable deep link to every implemented section', () => {
    const hrefs = SECTIONS.map((section) => controlSectionHref(section));

    expect(hrefs).toEqual(SECTIONS.map((section) => CONTROL_SECTION_HREFS[section]));
    expect(new Set(hrefs).size).toBe(SECTIONS.length);
    expect(controlSectionHref('home')).toBe('/control');
    expect(controlSectionHref('sales')).toBe('/control/sales');
    expect(controlSectionHref('customers')).toBe('/control/customers');
    expect(controlSectionHref('reports')).toBe('/control/reports');
  });

  it('round-trips every non-home route slug including stored-truth product surfaces', () => {
    for (const section of SECTIONS) {
      if (section === 'home') continue;
      const href = controlSectionHref(section);
      const slug = href.slice('/control/'.length);
      expect(controlSectionFromSlug(slug)).toBe(section);
    }
  });

  it('fails closed for unknown, root-like, and still-unbuilt P0 slugs', () => {
    expect(controlSectionFromSlug('')).toBeNull();
    expect(controlSectionFromSlug('home')).toBeNull();
    expect(controlSectionFromSlug('zatca')).toBeNull();
    expect(controlSectionFromSlug('../settings')).toBeNull();
  });
});
