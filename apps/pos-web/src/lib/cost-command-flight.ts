import type { InventoryCostBootstrapRequest } from './api-types';

export interface CostCommandIntent {
  readonly kind: 'bootstrap';
  readonly request: InventoryCostBootstrapRequest;
}

export type CostFlightOutcome = 'succeeded' | 'ambiguous' | 'amendable' | 'blocked';

export interface CostCommandFlight {
  begin(build: () => CostCommandIntent): CostCommandIntent | null;
  settle(outcome: CostFlightOutcome): void;
  pending(): CostCommandIntent | null;
  reset(): void;
}

function freezeIntent(intent: CostCommandIntent): CostCommandIntent {
  return Object.freeze({
    kind: intent.kind,
    request: Object.freeze({
      operationId: intent.request.operationId,
      branchId: intent.request.branchId,
      productId: intent.request.productId,
      totalValueMinor: intent.request.totalValueMinor,
      expectedStockRevision: intent.request.expectedStockRevision,
      expectedCostRevision: intent.request.expectedCostRevision,
      expectedUnknownPositiveQuantityScaled: intent.request.expectedUnknownPositiveQuantityScaled,
    }),
  });
}

/** Synchronously owns one exact, server-fingerprinted valuation decision. */
export function createCostCommandFlight(): CostCommandFlight {
  let running = false;
  let stopped = false;
  let intent: CostCommandIntent | null = null;

  return {
    begin(build) {
      if (running || stopped) return null;
      const next = intent ?? freezeIntent(build());
      intent = next;
      running = true;
      return next;
    },

    settle(outcome) {
      running = false;
      switch (outcome) {
        case 'succeeded':
        case 'blocked':
          stopped = true;
          return;
        case 'ambiguous':
          return;
        case 'amendable':
          intent = null;
          return;
      }
    },

    pending: () => intent,

    reset() {
      running = false;
      stopped = false;
      intent = null;
    },
  };
}
