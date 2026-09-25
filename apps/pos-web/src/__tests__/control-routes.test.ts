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
  'promotions',
  'customers',
  'branches',
  'staff',
  'reports',
  'settings',
  'migration',
  'zatca',
];

describe('merchant control route authority', () => {
  it('assigns one stable deep link to every implemented section', () => {
    const hrefs = SECTIONS.map((section) => controlSectionHref(section));

    expect(hrefs).toEqual(SECTIONS.map((section) => CONTROL_SECTION_HREFS[section]));
    expect(new Set(hrefs).size).toBe(SECTIONS.length);
    expect(controlSectionHref('home')).toBe('/control');
    expect(controlSectionHref('sales')).toBe('/control/sales');
    expect(controlSectionHref('customers')).toBe('/control/customers');
    expect(controlSectionHref('promotions')).toBe('/control/promotions');
    expect(controlSectionHref('reports')).toBe('/control/reports');
    expect(controlSectionHref('migration')).toBe('/control/migration');
    expect(controlSectionHref('zatca')).toBe('/control/zatca');
  });

  it('round-trips every non-home route slug including stored-truth product surfaces', () => {
    for (const section of SECTIONS) {
      if (section === 'home') continue;
      const href = controlSectionHref(section);
      const slug = href.slice('/control/'.length);
      expect(controlSectionFromSlug(slug)).toBe(section);
    }
  });

  it('fails closed for unknown and root-like slugs', () => {
    expect(controlSectionFromSlug('')).toBeNull();
    expect(controlSectionFromSlug('home')).toBeNull();
    expect(controlSectionFromSlug('../settings')).toBeNull();
  });
});
