import { describe, expect, it } from 'vitest';
import {
  pendingPreparationLines,
  pendingUnroutedPreparationLines,
  preparationReplacementPreservesFiredLines,
} from '../restaurant/preparation-policy.js';

const FIRST = {
  id: 'line-1',
  quantityScaled: '1000',
  preparationNote: 'بدون سكر',
  preparationOptions: null,
};
const SECOND = {
  id: 'line-2',
  quantityScaled: '1000',
  preparationNote: null,
  preparationOptions: null,
};

describe('restaurant preparation delta policy', () => {
  it('keeps fired lines immutable while allowing a new tail line', () => {
    expect(
      preparationReplacementPreservesFiredLines(
        [FIRST],
        new Set([FIRST.id]),
        [
          {
            lineId: FIRST.id,
            quantityScaled: '1000',
            preparationNote: 'بدون سكر',
            preparationOptions: null,
          },
          {
            productId: 'product-2',
            quantityScaled: '1000',
            preparationNote: null,
            preparationOptions: null,
          },
        ],
      ),
    ).toBe(true);
  });

  it.each([
    [
      'removal',
      [],
    ],
    [
      'quantity change',
      [
        {
          lineId: FIRST.id,
          quantityScaled: '2000',
          preparationNote: 'بدون سكر',
          preparationOptions: null,
        },
      ],
    ],
    [
      'preparation change',
      [
        {
          lineId: FIRST.id,
          quantityScaled: '1000',
          preparationNote: null,
          preparationOptions: null,
        },
      ],
    ],
    [
      'reordering behind a new item',
      [
        {
          productId: 'product-2',
          quantityScaled: '1000',
          preparationNote: null,
          preparationOptions: null,
        },
        {
          lineId: FIRST.id,
          quantityScaled: '1000',
          preparationNote: 'بدون سكر',
          preparationOptions: null,
        },
      ],
    ],
  ] as const)('rejects fired-line %s', (_label, requested) => {
    expect(
      preparationReplacementPreservesFiredLines([FIRST], new Set([FIRST.id]), requested),
    ).toBe(false);
  });

  it('still allows editing an unfired line after an earlier line has fired', () => {
    expect(
      preparationReplacementPreservesFiredLines(
        [FIRST, SECOND],
        new Set([FIRST.id]),
        [
          {
            lineId: FIRST.id,
            quantityScaled: '1000',
            preparationNote: 'بدون سكر',
            preparationOptions: null,
          },
          {
            lineId: SECOND.id,
            quantityScaled: '3000',
            preparationNote: 'ساخن',
            preparationOptions: null,
          },
        ],
      ),
    ).toBe(true);
  });

  it('selects only never-fired lines for the next fire and ignores old unrouted lines', () => {
    const fired = new Set([FIRST.id]);
    const groups = [
      {
        lines: [{ lineId: FIRST.id }, { lineId: SECOND.id }],
      },
    ];
    expect(pendingPreparationLines(groups, fired)).toEqual([{ lineId: SECOND.id }]);
    expect(
      pendingUnroutedPreparationLines([{ lineId: FIRST.id }, { lineId: 'line-3' }], fired),
    ).toEqual([{ lineId: 'line-3' }]);
  });
});
