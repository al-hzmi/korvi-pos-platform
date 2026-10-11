import { describe, expect, it } from 'vitest';
import { prepareMovementCost } from '../costing/ledger.js';

describe('restaurant recipe costing uses inventory cost authority', () => {
  it('returns an exact known value only when the outflow consumes no unknown quantity', () => {
    const known = prepareMovementCost(1000n, -250n, {
      knownQuantityScaled: 1000n,
      knownValueMinor: 400n,
      stockRevision: 1n,
      costRevision: 1n,
    }).evidence;
    expect(known).toEqual({
      knownQuantityScaled: 250n,
      unknownQuantityScaled: 0n,
      knownValueMinor: 100n,
      provenance: 'recorded',
    });

    const mixed = prepareMovementCost(1000n, -250n, {
      knownQuantityScaled: 800n,
      knownValueMinor: 320n,
      stockRevision: 1n,
      costRevision: 1n,
    }).evidence;
    expect(mixed.unknownQuantityScaled).toBe(200n);
    expect(mixed.knownValueMinor).toBe(20n);
    expect(mixed.provenance).toBe('mixed');
  });

  it('keeps insufficient stock beyond positive on-hand explicitly unknown', () => {
    const evidence = prepareMovementCost(100n, -250n, {
      knownQuantityScaled: 100n,
      knownValueMinor: 40n,
      stockRevision: 1n,
      costRevision: 1n,
    }).evidence;
    expect(evidence).toMatchObject({
      knownQuantityScaled: 100n,
      unknownQuantityScaled: 150n,
      knownValueMinor: 40n,
      provenance: 'mixed',
    });
  });
});
