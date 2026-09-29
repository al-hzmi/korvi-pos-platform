import { describe, expect, it } from 'vitest';
import { createInventoryCommandFlight } from '../inventory-command-flight';
import type { InventoryCommandIntent } from '../inventory-command-flight';

function adjustment(operationId: string): InventoryCommandIntent {
  return {
    kind: 'adjustment',
    request: {
      operationId,
      branchId: 'branch-1',
      reason: 'تلف',
      lines: [{ productId: 'product-1', deltaQuantityScaled: '-1000' }],
    },
  };
}

describe('inventory command flight', () => {
  it('claims synchronously so a double submit cannot mint two operations', () => {
    const flight = createInventoryCommandFlight();
    expect(flight.begin(() => adjustment('op-1'))?.request.operationId).toBe('op-1');
    expect(flight.begin(() => adjustment('op-2'))).toBeNull();
  });

  it('retries the frozen request unchanged after an ambiguous failure', () => {
    const flight = createInventoryCommandFlight();
    const first = flight.begin(() => adjustment('op-1'))!;
    flight.settle('ambiguous');

    const replay = flight.begin(() => adjustment('op-never-built'));
    expect(replay).toBe(first);
    expect(replay).toEqual(adjustment('op-1'));
    expect(flight.outstanding()).toBe(true);
  });

  it('deep-freezes lot-bearing stock intents so an ambiguous retry cannot mutate lot identity', () => {
    const flight = createInventoryCommandFlight();
    const first = flight.begin(() => ({
      kind: 'adjustment',
      request: {
        operationId: 'op-lot-1',
        branchId: 'branch-1',
        reason: 'تصحيح دفعة',
        lines: [
          {
            productId: 'product-1',
            deltaQuantityScaled: '1000',
            lot: {
              kind: 'manual-correction',
              externalBatchReference: 'BATCH-7',
              dateKind: 'expiry',
              dateValue: '2027-12-31',
            },
          },
        ],
      },
    }))!;

    expect(Object.isFrozen(first.request)).toBe(true);
    expect(Object.isFrozen(first.request.lines)).toBe(true);
    const adjustmentRequest = first.kind === 'adjustment' ? first.request : null;
    expect(adjustmentRequest).not.toBeNull();
    expect(Object.isFrozen(adjustmentRequest?.lines[0])).toBe(true);
    expect(Object.isFrozen(adjustmentRequest?.lines[0]?.lot)).toBe(true);

    flight.settle('ambiguous');
    expect(flight.begin(() => adjustment('op-never-built'))).toBe(first);
  });

  it('retires a definitely refused intent before accepting an amendment', () => {
    const flight = createInventoryCommandFlight();
    flight.begin(() => adjustment('op-1'));
    flight.settle('amendable');

    expect(flight.pending()).toBeNull();
    expect(flight.begin(() => adjustment('op-2'))?.request.operationId).toBe('op-2');
  });

  it('requires an explicit reset after success or a blocking conflict', () => {
    const flight = createInventoryCommandFlight();
    flight.begin(() => adjustment('op-1'));
    flight.settle('succeeded');
    expect(flight.begin(() => adjustment('op-2'))).toBeNull();

    flight.reset();
    expect(flight.begin(() => adjustment('op-2'))?.request.operationId).toBe('op-2');
  });
});
