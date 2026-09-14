import { describe, expect, it } from 'vitest';
import {
  CONTROL_SECTION_HREFS,
  controlSectionFromSlug,
  controlSectionHref,
  type ControlSection,
} from '../lib/control-routes';

const SECTIONS: readonly ControlSection[] = [
  'home',
  'products',
  'inventory',
  'purchasing',
  'branches',
  'staff',
  'settings',
];

describe('merchant control route authority', () => {
  it('assigns one stable deep link to every implemented section', () => {
    const hrefs = SECTIONS.map((section) => controlSectionHref(section));

    expect(hrefs).toEqual(SECTIONS.map((section) => CONTROL_SECTION_HREFS[section]));
    expect(new Set(hrefs).size).toBe(SECTIONS.length);
    expect(controlSectionHref('home')).toBe('/control');
  });

  it('round-trips every non-home route slug', () => {
    for (const section of SECTIONS) {
      if (section === 'home') continue;
      const href = controlSectionHref(section);
      const slug = href.slice('/control/'.length);
      expect(controlSectionFromSlug(slug)).toBe(section);
    }
  });

  it('fails closed for unknown or root-like slugs', () => {
    expect(controlSectionFromSlug('')).toBeNull();
    expect(controlSectionFromSlug('home')).toBeNull();
    expect(controlSectionFromSlug('sales')).toBeNull();
    expect(controlSectionFromSlug('../settings')).toBeNull();
  });
});
