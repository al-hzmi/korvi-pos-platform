import { describe, expect, it } from 'vitest';
import { controlSectionHref, resolveControlRoute } from '../components/control/control-nav';

describe('merchant control-centre route authority', () => {
  it('lets the /control entry route choose the first authorized surface', () => {
    expect(resolveControlRoute(null, ['product.read'])).toEqual({
      kind: 'section',
      section: 'products',
    });
  });

  it('keeps an authorized explicit deep link as the active surface', () => {
    expect(resolveControlRoute('inventory', ['product.read', 'inventory.read'])).toEqual({
      kind: 'section',
      section: 'inventory',
    });
  });

  it('does not silently fall through when an explicit deep link is forbidden', () => {
    expect(resolveControlRoute('inventory', ['product.read'])).toEqual({
      kind: 'forbidden',
      section: 'inventory',
    });
  });

  it('rejects unknown and not-yet-built surface keys instead of inventing UI authority', () => {
    expect(resolveControlRoute('sales', ['report.read'])).toEqual({ kind: 'invalid' });
    expect(resolveControlRoute('not-a-surface', ['report.read'])).toEqual({ kind: 'invalid' });
  });

  it('gives every built surface a stable bookmarkable URL', () => {
    expect(controlSectionHref('home')).toBe('/control/home');
    expect(controlSectionHref('purchasing')).toBe('/control/purchasing');
    expect(controlSectionHref('settings')).toBe('/control/settings');
  });
});
