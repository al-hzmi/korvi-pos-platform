import { describe, expect, it } from 'vitest';
import {
  ContextPriceError,
  resolveContextPrice,
  type ContextPriceList,
} from '../context-price.js';

const PRODUCT = '018fd100-0000-7000-8000-000000000001';
const PACKAGE = '018fd100-0000-7000-8000-000000000002';

function list(
  context: 'retail' | 'wholesale',
  entries: ContextPriceList['entries'],
  overrides: Partial<ContextPriceList> = {},
): ContextPriceList {
  return {
    id: context === 'retail' ? 'retail-list' : 'wholesale-list',
    code: context === 'retail' ? 'RETAIL' : 'WHOLESALE',
    context,
    status: 'active',
    revision: 7n,
    entries,
    ...overrides,
  };
}

const baseTarget = {
  productId: PRODUCT,
  packageId: null,
  packageBaseQuantityScaled: null,
  productBasePriceMinor: 1_000n,
} as const;

const cartonTarget = {
  productId: PRODUCT,
  packageId: PACKAGE,
  packageBaseQuantityScaled: 12_000n,
  productBasePriceMinor: 1_000n,
} as const;

describe('ADR-0038 contextual price resolution', () => {
  it('uses current Product price for default retail base sale without a list', () => {
    expect(resolveContextPrice({ context: 'retail', target: baseTarget, lists: [] })).toEqual({
      context: 'retail',
      unitPriceMinor: 1_000n,
      provenance: 'product-base',
      priceListId: null,
      priceListCode: null,
      priceListRevision: null,
    });
  });

  it('uses exact package entry without dividing it into a base-unit price', () => {
    const resolved = resolveContextPrice({
      context: 'retail',
      target: cartonTarget,
      lists: [
        list('retail', [{ productId: PRODUCT, packageId: PACKAGE, priceMinor: 10_001n }]),
      ],
    });
    expect(resolved.unitPriceMinor).toBe(10_001n);
    expect(resolved.provenance).toBe('price-list-package');
  });

  it('multiplies a list base price exactly when the package has no override', () => {
    const resolved = resolveContextPrice({
      context: 'retail',
      target: cartonTarget,
      lists: [list('retail', [{ productId: PRODUCT, packageId: null, priceMinor: 900n }])],
    });
    expect(resolved.unitPriceMinor).toBe(10_800n);
    expect(resolved.provenance).toBe('price-list-base');
  });

  it('falls back to Product base price only in retail context', () => {
    expect(
      resolveContextPrice({ context: 'retail', target: cartonTarget, lists: [] }).unitPriceMinor,
    ).toBe(12_000n);

    expect(() =>
      resolveContextPrice({ context: 'wholesale', target: cartonTarget, lists: [] }),
    ).toThrow(ContextPriceError);
  });

  it('refuses wholesale when an active list lacks an applicable price', () => {
    try {
      resolveContextPrice({
        context: 'wholesale',
        target: cartonTarget,
        lists: [
          list('wholesale', [
            {
              productId: '018fd100-0000-7000-8000-000000000099',
              packageId: null,
              priceMinor: 500n,
            },
          ]),
        ],
      });
      throw new Error('expected wholesale refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextPriceError);
      expect((error as ContextPriceError).detail).toBe('wholesale-price-incomplete');
    }
  });

  it('uses exact wholesale package price when present', () => {
    const resolved = resolveContextPrice({
      context: 'wholesale',
      target: cartonTarget,
      lists: [
        list('wholesale', [{ productId: PRODUCT, packageId: PACKAGE, priceMinor: 9_500n }]),
      ],
    });
    expect(resolved.unitPriceMinor).toBe(9_500n);
    expect(resolved.priceListCode).toBe('WHOLESALE');
  });

  it('refuses two active lists for one context instead of choosing by accident', () => {
    try {
      resolveContextPrice({
        context: 'retail',
        target: baseTarget,
        lists: [
          list('retail', []),
          list('retail', [], { id: 'second', code: 'SECOND', revision: 8n }),
        ],
      });
      throw new Error('expected ambiguity refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextPriceError);
      expect((error as ContextPriceError).detail).toBe('ambiguous-active-list');
    }
  });

  it('ignores paused lists and preserves deterministic retail fallback', () => {
    const resolved = resolveContextPrice({
      context: 'retail',
      target: cartonTarget,
      lists: [
        list(
          'retail',
          [{ productId: PRODUCT, packageId: PACKAGE, priceMinor: 1n }],
          { status: 'paused' },
        ),
      ],
    });
    expect(resolved.unitPriceMinor).toBe(12_000n);
    expect(resolved.provenance).toBe('product-base');
  });

  it('refuses duplicate entries for the same target', () => {
    try {
      resolveContextPrice({
        context: 'retail',
        target: cartonTarget,
        lists: [
          list('retail', [
            { productId: PRODUCT, packageId: PACKAGE, priceMinor: 10_000n },
            { productId: PRODUCT, packageId: PACKAGE, priceMinor: 9_999n },
          ]),
        ],
      });
      throw new Error('expected duplicate refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextPriceError);
      expect((error as ContextPriceError).detail).toBe('duplicate-price-entry');
    }
  });

  it('never produces a negative price', () => {
    try {
      resolveContextPrice({
        context: 'retail',
        target: baseTarget,
        lists: [list('retail', [{ productId: PRODUCT, packageId: null, priceMinor: -1n }])],
      });
      throw new Error('expected negative price refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ContextPriceError);
      expect((error as ContextPriceError).detail).toBe('invalid-entry-price');
    }
  });

  it('is stable across package factors when deriving a base-entry price', () => {
    for (let units = 2n; units <= 80n; units += 1n) {
      const target = {
        ...cartonTarget,
        packageBaseQuantityScaled: units * 1_000n,
      };
      const resolved = resolveContextPrice({
        context: 'retail',
        target,
        lists: [list('retail', [{ productId: PRODUCT, packageId: null, priceMinor: 137n }])],
      });
      expect(resolved.unitPriceMinor).toBe(137n * units);
    }
  });
});
