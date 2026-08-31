import { describe, expect, it } from 'vitest';
import { createCostCommandFlight } from '../cost-command-flight';
import type { CostCommandIntent } from '../cost-command-flight';

function intent(operationId: string, totalValueMinor = '100'): CostCommandIntent {
  return {
    kind: 'bootstrap',
    request: {
      operationId,
      branchId: 'branch-1',
      productId: 'product-1',
      totalValueMinor,
    },
  };
}

describe('cost command flight', () => {
  it('claims synchronously and retries the same frozen operation after ambiguity', () => {
    const flight = createCostCommandFlight();
    const first = flight.begin(() => intent('op-1', '9007199254740993'));
    expect(first).not.toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.request)).toBe(true);
    expect(flight.begin(() => intent('op-2'))).toBeNull();

    flight.settle('ambiguous');
    expect(flight.pending()).toBe(first);
    expect(flight.begin(() => intent('op-3'))).toBe(first);
  });

  it('retires an amendable intent and permanently stops success or conflict', () => {
    const flight = createCostCommandFlight();
    expect(flight.begin(() => intent('op-1'))?.request.operationId).toBe('op-1');
    flight.settle('amendable');
    expect(flight.begin(() => intent('op-2'))?.request.operationId).toBe('op-2');
    flight.settle('succeeded');
    expect(flight.begin(() => intent('op-3'))).toBeNull();

    flight.reset();
    expect(flight.begin(() => intent('op-4'))?.request.operationId).toBe('op-4');
    flight.settle('blocked');
    expect(flight.begin(() => intent('op-5'))).toBeNull();
  });
});
