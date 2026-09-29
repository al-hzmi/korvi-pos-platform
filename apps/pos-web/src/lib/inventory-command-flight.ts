import type {
  InventoryAdjustmentRequest,
  InventoryCountRequest,
  InventoryTransferRequest,
} from './api-types';

/** One server-fingerprinted stock command, including its operation identity. */
export type InventoryCommandIntent =
  | { readonly kind: 'adjustment'; readonly request: InventoryAdjustmentRequest }
  | { readonly kind: 'count'; readonly request: InventoryCountRequest }
  | { readonly kind: 'transfer'; readonly request: InventoryTransferRequest };

export type InventoryFlightOutcome = 'succeeded' | 'ambiguous' | 'amendable' | 'blocked';

export interface InventoryCommandFlight {
  /** Claims the browser flight synchronously; a double submit receives null. */
  begin(build: () => InventoryCommandIntent): InventoryCommandIntent | null;
  settle(outcome: InventoryFlightOutcome): void;
  pending(): InventoryCommandIntent | null;
  running(): boolean;
  outstanding(): boolean;
  blocked(): boolean;
  /** Explicitly begins a new human decision after success or reconciliation. */
  reset(): void;
}

function freezeAdjustmentLines(
  lines: InventoryAdjustmentRequest['lines'],
): InventoryAdjustmentRequest['lines'] {
  return Object.freeze(
    lines.map((line) =>
      Object.freeze({
        productId: line.productId,
        deltaQuantityScaled: line.deltaQuantityScaled,
        ...(line.lot === undefined
          ? {}
          : {
              lot: Object.freeze(
                line.lot.kind === 'existing'
                  ? { kind: 'existing' as const, lotId: line.lot.lotId }
                  : {
                      kind: 'manual-correction' as const,
                      externalBatchReference: line.lot.externalBatchReference,
                      dateKind: line.lot.dateKind,
                      dateValue: line.lot.dateValue,
                    },
              ),
            }),
      }),
    ),
  );
}

function freezeCountLines(lines: InventoryCountRequest['lines']): InventoryCountRequest['lines'] {
  return Object.freeze(
    lines.map((line) =>
      Object.freeze({
        productId: line.productId,
        countedQuantityScaled: line.countedQuantityScaled,
        expectedRevision: line.expectedRevision,
        ...(line.lots === undefined
          ? {}
          : {
              lots: Object.freeze(
                line.lots.map((lot) =>
                  Object.freeze({
                    lotId: lot.lotId,
                    countedQuantityScaled: lot.countedQuantityScaled,
                  }),
                ),
              ),
            }),
      }),
    ),
  );
}

function freezeTransferLines(
  lines: InventoryTransferRequest['lines'],
): InventoryTransferRequest['lines'] {
  return Object.freeze(
    lines.map((line) =>
      Object.freeze({
        productId: line.productId,
        quantityScaled: line.quantityScaled,
      }),
    ),
  );
}

/**
 * Freeze the exact request whose hash the server owns. A retry never rebuilds
 * from mutable form fields and therefore cannot turn one operation id into a
 * different stock instruction.
 */
function freezeIntent(intent: InventoryCommandIntent): InventoryCommandIntent {
  switch (intent.kind) {
    case 'adjustment':
      return Object.freeze({
        kind: intent.kind,
        request: Object.freeze({
          operationId: intent.request.operationId,
          branchId: intent.request.branchId,
          reason: intent.request.reason,
          lines: freezeAdjustmentLines(intent.request.lines),
        }),
      });
    case 'count':
      return Object.freeze({
        kind: intent.kind,
        request: Object.freeze({
          operationId: intent.request.operationId,
          branchId: intent.request.branchId,
          reason: intent.request.reason,
          lines: freezeCountLines(intent.request.lines),
        }),
      });
    case 'transfer':
      return Object.freeze({
        kind: intent.kind,
        request: Object.freeze({
          operationId: intent.request.operationId,
          fromBranchId: intent.request.fromBranchId,
          toBranchId: intent.request.toBranchId,
          reason: intent.request.reason,
          lines: freezeTransferLines(intent.request.lines),
        }),
      });
  }
}

export function createInventoryCommandFlight(): InventoryCommandFlight {
  let inFlight = false;
  let intent: InventoryCommandIntent | null = null;
  let ambiguous = false;
  let stopped = false;

  return {
    begin(build) {
      if (inFlight || stopped) return null;
      const next = intent ?? freezeIntent(build());
      intent = next;
      inFlight = true;
      return next;
    },

    settle(outcome) {
      inFlight = false;
      switch (outcome) {
        case 'succeeded':
          ambiguous = false;
          stopped = true;
          return;
        case 'ambiguous':
          ambiguous = true;
          return;
        case 'amendable':
          ambiguous = false;
          intent = null;
          return;
        case 'blocked':
          ambiguous = false;
          stopped = true;
          return;
      }
    },

    pending: () => intent,
    running: () => inFlight,
    outstanding: () => ambiguous,
    blocked: () => stopped,

    reset() {
      inFlight = false;
      intent = null;
      ambiguous = false;
      stopped = false;
    },
  };
}
