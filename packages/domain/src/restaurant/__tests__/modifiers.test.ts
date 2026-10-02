import { describe, expect, it } from 'vitest';
import {
  InvalidRestaurantModifierDefinitionError,
  InvalidRestaurantModifierSelectionError,
  resolveRestaurantModifiers,
  type RestaurantModifierGroupPolicy,
} from '../modifiers.js';

function group(
  overrides: Partial<RestaurantModifierGroupPolicy> = {},
): RestaurantModifierGroupPolicy {
  return {
    groupId: '00000000-0000-7000-8000-000000000100',
    revision: 1n,
    code: 'SIZE',
    nameAr: 'الحجم',
    minSelections: 1,
    maxSelections: 1,
    sortOrder: 10,
    isActive: true,
    options: [
      {
        optionId: '00000000-0000-7000-8000-000000000101',
        revision: 1n,
        code: 'REGULAR',
        nameAr: 'عادي',
        priceDeltaMinor: 0n,
        sortOrder: 10,
        isActive: true,
      },
      {
        optionId: '00000000-0000-7000-8000-000000000102',
        revision: 2n,
        code: 'LARGE',
        nameAr: 'كبير',
        priceDeltaMinor: 200n,
        sortOrder: 20,
        isActive: true,
      },
    ],
    ...overrides,
  };
}

describe('restaurant modifier resolver', () => {
  it('adds selected option deltas to the base price and snapshots exact policy facts', () => {
    const result = resolveRestaurantModifiers({
      baseUnitPriceMinor: 1_000n,
      groups: [group()],
      selectedOptionIds: ['00000000-0000-7000-8000-000000000102'],
    });

    expect(result.baseUnitPriceMinor).toBe(1_000n);
    expect(result.modifierTotalMinor).toBe(200n);
    expect(result.unitPriceMinor).toBe(1_200n);
    expect(result.selections).toEqual([
      {
        groupId: '00000000-0000-7000-8000-000000000100',
        groupRevision: 1n,
        groupCode: 'SIZE',
        groupNameAr: 'الحجم',
        groupSortOrder: 10,
        optionId: '00000000-0000-7000-8000-000000000102',
        optionRevision: 2n,
        optionCode: 'LARGE',
        optionNameAr: 'كبير',
        optionSortOrder: 20,
        priceDeltaMinor: 200n,
      },
    ]);
  });

  it('allows zero-price options without inventing a discount', () => {
    const result = resolveRestaurantModifiers({
      baseUnitPriceMinor: 500n,
      groups: [group()],
      selectedOptionIds: ['00000000-0000-7000-8000-000000000101'],
    });
    expect(result.modifierTotalMinor).toBe(0n);
    expect(result.unitPriceMinor).toBe(500n);
  });

  it('refuses a missing required selection', () => {
    expect(() =>
      resolveRestaurantModifiers({
        baseUnitPriceMinor: 500n,
        groups: [group()],
        selectedOptionIds: [],
      }),
    ).toThrow(InvalidRestaurantModifierSelectionError);
  });

  it('refuses too many selections for one group', () => {
    expect(() =>
      resolveRestaurantModifiers({
        baseUnitPriceMinor: 500n,
        groups: [group()],
        selectedOptionIds: [
          '00000000-0000-7000-8000-000000000101',
          '00000000-0000-7000-8000-000000000102',
        ],
      }),
    ).toThrow(InvalidRestaurantModifierSelectionError);
  });

  it('refuses duplicate selected option ids', () => {
    expect(() =>
      resolveRestaurantModifiers({
        baseUnitPriceMinor: 500n,
        groups: [group({ minSelections: 0, maxSelections: 2 })],
        selectedOptionIds: [
          '00000000-0000-7000-8000-000000000101',
          '00000000-0000-7000-8000-000000000101',
        ],
      }),
    ).toThrow(InvalidRestaurantModifierSelectionError);
  });

  it('refuses inactive, unknown or unattached options', () => {
    expect(() =>
      resolveRestaurantModifiers({
        baseUnitPriceMinor: 500n,
        groups: [group({ minSelections: 0 })],
        selectedOptionIds: ['00000000-0000-7000-8000-000000000999'],
      }),
    ).toThrow(InvalidRestaurantModifierSelectionError);

    const inactive = group({
      minSelections: 0,
      options: [
        {
          optionId: '00000000-0000-7000-8000-000000000101',
          revision: 1n,
          code: 'REGULAR',
          nameAr: 'عادي',
          priceDeltaMinor: 0n,
          sortOrder: 10,
          isActive: false,
        },
      ],
    });
    expect(() =>
      resolveRestaurantModifiers({
        baseUnitPriceMinor: 500n,
        groups: [inactive],
        selectedOptionIds: ['00000000-0000-7000-8000-000000000101'],
      }),
    ).toThrow(InvalidRestaurantModifierSelectionError);
  });

  it('orders snapshots deterministically by group and option policy order', () => {
    const extras = group({
      groupId: '00000000-0000-7000-8000-000000000200',
      code: 'EXTRA',
      nameAr: 'إضافات',
      minSelections: 0,
      maxSelections: 2,
      sortOrder: 20,
      options: [
        {
          optionId: '00000000-0000-7000-8000-000000000202',
          revision: 1n,
          code: 'CHEESE',
          nameAr: 'جبن',
          priceDeltaMinor: 100n,
          sortOrder: 20,
          isActive: true,
        },
        {
          optionId: '00000000-0000-7000-8000-000000000201',
          revision: 1n,
          code: 'SAUCE',
          nameAr: 'صوص',
          priceDeltaMinor: 50n,
          sortOrder: 10,
          isActive: true,
        },
      ],
    });
    const result = resolveRestaurantModifiers({
      baseUnitPriceMinor: 1_000n,
      groups: [extras, group()],
      selectedOptionIds: [
        '00000000-0000-7000-8000-000000000202',
        '00000000-0000-7000-8000-000000000102',
        '00000000-0000-7000-8000-000000000201',
      ],
    });

    expect(result.selections.map((selection) => selection.optionCode)).toEqual([
      'LARGE',
      'SAUCE',
      'CHEESE',
    ]);
    expect(result.unitPriceMinor).toBe(1_350n);
  });

  it('rejects negative price deltas as malformed policy', () => {
    const invalid = group({
      options: [
        {
          optionId: '00000000-0000-7000-8000-000000000101',
          revision: 1n,
          code: 'BAD',
          nameAr: 'غير صالح',
          priceDeltaMinor: -1n,
          sortOrder: 1,
          isActive: true,
        },
      ],
    });
    expect(() =>
      resolveRestaurantModifiers({
        baseUnitPriceMinor: 100n,
        groups: [invalid],
        selectedOptionIds: ['00000000-0000-7000-8000-000000000101'],
      }),
    ).toThrow(InvalidRestaurantModifierDefinitionError);
  });
});
