import { describe, expect, it } from 'vitest';
import {
  MAX_SCALED_QUANTITY,
  PackagingError,
  assertPackageBaseQuantityScaled,
  baseInventoryQuantityScaled,
  packageInventoryQuantityScaled,
} from '../packaging.js';

describe('ADR-0038 package conversion', () => {
  it('converts whole commercial package count into exact base quantity', () => {
    expect(
      packageInventoryQuantityScaled({
        commercialQuantityScaled: 3_000n,
        packageBaseQuantityScaled: 12_000n,
      }),
    ).toBe(36_000n);
  });

  it('refuses fractional package counts and invalid package factors', () => {
    expect(() =>
      packageInventoryQuantityScaled({
        commercialQuantityScaled: 500n,
        packageBaseQuantityScaled: 12_000n,
      }),
    ).toThrow(PackagingError);
    expect(() => assertPackageBaseQuantityScaled(12_500n)).toThrow(PackagingError);
    expect(() => assertPackageBaseQuantityScaled(1_000n)).toThrow(PackagingError);
  });

  it('keeps base-unit commerce unchanged', () => {
    expect(baseInventoryQuantityScaled(125_000n)).toBe(125_000n);
  });

  it('refuses conversion overflow before persistence', () => {
    expect(() =>
      packageInventoryQuantityScaled({
        commercialQuantityScaled: 2_000n,
        packageBaseQuantityScaled: MAX_SCALED_QUANTITY - 999n,
      }),
    ).toThrow(PackagingError);
  });

  it('is exact across a matrix of whole package factors and counts', () => {
    for (let unitsPerPackage = 2n; unitsPerPackage <= 100n; unitsPerPackage += 1n) {
      for (let packages = 1n; packages <= 75n; packages += 1n) {
        const factor = unitsPerPackage * 1_000n;
        const commercial = packages * 1_000n;
        expect(
          packageInventoryQuantityScaled({
            commercialQuantityScaled: commercial,
            packageBaseQuantityScaled: factor,
          }),
        ).toBe(packages * factor);
      }
    }
  });
});
