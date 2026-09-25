import { describe, expect, it } from 'vitest';
import {
  CategoryBootstrapError,
  normalizeCategoryBootstrap,
  normalizeCategoryName,
} from '../../index.js';

describe('category bootstrap invariants', () => {
  it('normalizes names without inventing hierarchy or identifiers', () => {
    expect(
      normalizeCategoryBootstrap({
        nameAr: '  مشروبات   باردة  ',
        nameEn: ' Cold   Drinks ',
        sortOrder: 20,
      }),
    ).toEqual({
      nameAr: 'مشروبات باردة',
      nameEn: 'Cold Drinks',
      sortOrder: 20,
    });
  });

  it('turns a blank optional English name into null', () => {
    expect(normalizeCategoryBootstrap({ nameAr: 'قهوة', nameEn: '   ' }).nameEn).toBeNull();
  });

  it('rejects empty/control-heavy names and unsafe sort orders', () => {
    for (const bad of ['', '   ', 'قهوة\nساخنة']) {
      expect(() => normalizeCategoryName(bad), bad).toThrow(CategoryBootstrapError);
    }
    for (const sortOrder of [-1, 1.5, 1_000_001]) {
      expect(() => normalizeCategoryBootstrap({ nameAr: 'قهوة', sortOrder })).toThrow(
        CategoryBootstrapError,
      );
    }
  });
});
