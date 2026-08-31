import { describe, expect, it } from 'vitest';
import { createPurchasingCommandFlight } from '../purchasing-command-flight';
import type { PurchasingCommandIntent } from '../purchasing-command-flight';

function intent(operationId: string): PurchasingCommandIntent {
  return {
    kind: 'order-create',
    request: {
      operationId,
      supplierId: 'supplier-1',
      branchId: 'branch-1',
      reference: null,
      lines: [{ productId: 'product-1', orderedQuantityScaled: '900719925474099300' }],
    },
  };
}

describe('purchasing command flight', () => {
  it('claims synchronously so a double submit cannot mint a second operation', () => {
    const flight = createPurchasingCommandFlight();
    let minted = 0;
    const first = flight.begin(() => intent(`op-${String(++minted)}`));
    const second = flight.begin(() => intent(`op-${String(++minted)}`));

    expect(first?.request.operationId).toBe('op-1');
    expect(second).toBeNull();
    expect(minted).toBe(1);
  });

  it('reuses one frozen request after an ambiguous outcome', () => {
    const flight = createPurchasingCommandFlight();
    const first = flight.begin(() => intent('op-fixed'));
    flight.settle('ambiguous');
    const retry = flight.begin(() => intent('op-wrong'));

    expect(retry).toBe(first);
    expect(retry?.request.operationId).toBe('op-fixed');
    expect(Object.isFrozen(retry?.request)).toBe(true);
    if (retry?.kind === 'order-create') {
      expect(Object.isFrozen(retry.request.lines)).toBe(true);
      expect(Object.isFrozen(retry.request.lines[0])).toBe(true);
    }
  });

  it('retires an operation after a typed refusal before accepting an amendment', () => {
    const flight = createPurchasingCommandFlight();
    flight.begin(() => intent('op-old'));
    flight.settle('amendable');
    expect(flight.begin(() => intent('op-new'))?.request.operationId).toBe('op-new');
  });

  it('stops after success until the operator explicitly starts a new decision', () => {
    const flight = createPurchasingCommandFlight();
    flight.begin(() => intent('op-done'));
    flight.settle('succeeded');
    expect(flight.begin(() => intent('op-hidden'))).toBeNull();
    flight.reset();
    expect(flight.begin(() => intent('op-next'))?.request.operationId).toBe('op-next');
  });
});
