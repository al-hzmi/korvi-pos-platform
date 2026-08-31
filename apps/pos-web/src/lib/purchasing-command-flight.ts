import type {
  PurchaseOrderCreateRequest,
  PurchaseReceiptCreateRequest,
  SupplierCreateRequest,
  SupplierUpdateRequest,
} from './api-types';

export type PurchasingCommandIntent =
  | { readonly kind: 'supplier-create'; readonly request: SupplierCreateRequest }
  | { readonly kind: 'supplier-update'; readonly request: SupplierUpdateRequest }
  | { readonly kind: 'order-create'; readonly request: PurchaseOrderCreateRequest }
  | { readonly kind: 'receipt'; readonly request: PurchaseReceiptCreateRequest };

export type PurchasingFlightOutcome = 'succeeded' | 'ambiguous' | 'amendable' | 'blocked';

export interface PurchasingCommandFlight {
  begin(build: () => PurchasingCommandIntent): PurchasingCommandIntent | null;
  settle(outcome: PurchasingFlightOutcome): void;
  pending(): PurchasingCommandIntent | null;
  reset(): void;
}

function freezeLines<T extends Readonly<Record<string, string>>>(
  lines: readonly T[],
): readonly Readonly<T>[] {
  return Object.freeze(lines.map((line) => Object.freeze({ ...line }) as Readonly<T>));
}

/**
 * Freeze the complete server-fingerprinted intent before the first await.
 * A timeout retry therefore cannot absorb an edited supplier, branch,
 * reference, quantity or line set under an already-claimed operation id.
 */
function freezeIntent(intent: PurchasingCommandIntent): PurchasingCommandIntent {
  switch (intent.kind) {
    case 'supplier-create':
      return Object.freeze({
        kind: intent.kind,
        request: Object.freeze({ ...intent.request }),
      });
    case 'supplier-update':
      return Object.freeze({
        kind: intent.kind,
        request: Object.freeze({ ...intent.request }),
      });
    case 'order-create':
      return Object.freeze({
        kind: intent.kind,
        request: Object.freeze({
          operationId: intent.request.operationId,
          supplierId: intent.request.supplierId,
          branchId: intent.request.branchId,
          reference: intent.request.reference,
          lines: freezeLines(intent.request.lines),
        }),
      });
    case 'receipt':
      return Object.freeze({
        kind: intent.kind,
        request: Object.freeze({
          operationId: intent.request.operationId,
          purchaseOrderId: intent.request.purchaseOrderId,
          reference: intent.request.reference,
          lines: freezeLines(intent.request.lines),
        }),
      });
  }
}

export function createPurchasingCommandFlight(): PurchasingCommandFlight {
  let running = false;
  let stopped = false;
  let intent: PurchasingCommandIntent | null = null;

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
