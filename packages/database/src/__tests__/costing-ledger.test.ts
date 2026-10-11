import { describe, expect, it } from 'vitest';
import { CostingCapacityError } from '@korvi/domain';
import { prepareMovementCost } from '../costing/ledger.js';

describe('movement cost storage boundaries', () => {
  it('refuses a known inflow whose aggregate value would overflow PostgreSQL BIGINT', () => {
    expect(() =>
      prepareMovementCost(
        2000n,
        1000n,
        {
          knownQuantityScaled: 1000n,
          knownValueMinor: 9_223_372_036_854_775_807n,
          stockRevision: 1n,
          costRevision: 1n,
        },
        {
          knownQuantityScaled: 1000n,
          unknownQuantityScaled: 0n,
          knownValueMinor: 1n,
        },
      ),
    ).toThrow(CostingCapacityError);
  });
});
