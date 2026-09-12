from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}")
    write(path, text.replace(old, new, 1))


# The browser may carry the shift under which cash was accepted only as a replay
# precondition. The server still derives the active shift and remains authority.
replace_once(
    "apps/pos-web/src/lib/api-types.ts",
    "export interface CheckoutRequest {\n  readonly operationId: string;\n  readonly terminalId: string;\n  readonly cashReceivedMinor: string;",
    "export interface CheckoutRequest {\n  readonly operationId: string;\n  readonly terminalId: string;\n  /** Delayed/offline replay precondition. The server derives the active shift and only compares. */\n  readonly expectedShiftId?: string;\n  readonly cashReceivedMinor: string;",
)

replace_once(
    "apps/pos-web/src/lib/api.ts",
    "            operationId: request.operationId,\n            terminalId: request.terminalId,\n            cashReceivedMinor: request.cashReceivedMinor,",
    "            operationId: request.operationId,\n            terminalId: request.terminalId,\n            ...(request.expectedShiftId === undefined\n              ? {}\n              : { expectedShiftId: request.expectedShiftId }),\n            cashReceivedMinor: request.cashReceivedMinor,",
)

replace_once(
    "apps/api/src/routes/validation.ts",
    "    operationId: UUID,\n    terminalId: UUID,\n    cashReceivedMinor: MINOR.optional(),",
    "    operationId: UUID,\n    terminalId: UUID,\n    // Replay precondition, not an authority assertion. The server derives the\n    // active shift and refuses if it no longer matches this immutable intent.\n    expectedShiftId: UUID.optional(),\n    cashReceivedMinor: MINOR.optional(),",
)

replace_once(
    "apps/api/src/routes/business.ts",
    "        operationId: parsed.data.operationId,\n        terminalId: parsed.data.terminalId,\n        lines: parsed.data.lines,",
    "        operationId: parsed.data.operationId,\n        terminalId: parsed.data.terminalId,\n        ...(parsed.data.expectedShiftId === undefined\n          ? {}\n          : { expectedShiftId: parsed.data.expectedShiftId }),\n        lines: parsed.data.lines,",
)

replace_once(
    "apps/api/src/checkout/service.ts",
    "  readonly operationId: string;\n  readonly terminalId: string;\n  readonly lines: readonly CheckoutLineInput[];",
    "  readonly operationId: string;\n  readonly terminalId: string;\n  /**\n   * Optional immutable precondition used by delayed/offline replay. The client\n   * does not choose a shift: the server still derives the current open shift\n   * and merely refuses if it is no longer the one under which the intent was captured.\n   */\n  readonly expectedShiftId?: string | undefined;\n  readonly lines: readonly CheckoutLineInput[];",
)

service_path = "apps/api/src/checkout/service.ts"
service = read(service_path)
marker = "const IDEMPOTENCY_SCOPE = 'checkout';"
if service.count(marker) != 1:
    raise SystemExit("checkout service fingerprint marker missing")
helper = """function fingerprintCheckoutIntent(
  input: CheckoutInput,
  payment: readonly CheckoutTenderInput[],
  branchId: string,
): string {
  return fingerprintIntent({
    branchId,
    terminalId: input.terminalId,
    lines: input.lines.map((line) => ({
      productId: line.productId,
      quantityScaled: line.quantityScaled,
      discount: describeDiscount(line.discount),
    })),
    tenders: payment.map((tender) => ({
      kind: tender.kind,
      amountMinor: tender.amountMinor,
      scheme: tender.kind === 'electronic' ? tender.scheme : '',
      reference: tender.kind === 'electronic' ? tender.reference : '',
    })),
    basketDiscount: describeDiscount(input.basketDiscount),
  });
}

"""
service = service.replace(marker, helper + marker, 1)

old_block_start = "      const shift = await deps.shifts.findOpenForTerminal(scope, input.terminalId);"
old_block_end = "      const tenant = await deps.tenants.current(scope);"
start = service.find(old_block_start)
end = service.find(old_block_end, start)
if start < 0 or end < 0:
    raise SystemExit("checkout service preflight block markers missing")
new_block = """      const payment = normalizePayment(input);
      if (typeof payment === 'string') return fail(payment);

      /*
       * Resolve committed idempotency before consulting today's shift. After a
       * long outage the first request may have committed while its response was
       * lost, and that shift can be closed by the time the exact command is
       * replayed. A completed sale must remain discoverable rather than being
       * turned into a false no-open-shift refusal.
       */
      const reserved = await deps.idempotency.find(scope, IDEMPOTENCY_SCOPE, input.operationId);
      if (reserved !== null) {
        const existing = await deps.sales.findByOperationId(scope, input.operationId);
        if (existing === null) return fail('idempotency-conflict');
        if (input.expectedShiftId !== undefined && existing.shiftId !== input.expectedShiftId) {
          return fail('idempotency-conflict');
        }
        const replayHash = fingerprintCheckoutIntent(input, payment, existing.branchId);
        if (reserved.requestHash !== replayHash) return fail('idempotency-conflict');
        const invoice = await deps.sales.invoiceForSale(scope, existing.id);
        return {
          outcome: 'success',
          replayed: true,
          sale: summarise(existing, invoice?.invoiceNumber ?? '', input.principal.displayName),
        };
      }

      const shift = await deps.shifts.findOpenForTerminal(scope, input.terminalId);
      if (shift === null) return fail('no-open-shift');
      // The drawer belongs to one cashier. Ringing into somebody else's shift
      // makes their variance unanswerable at close.
      if (shift.userId !== input.principal.userId) return fail('shift-invalid');
      // Delayed cash stays pinned to the shift that existed when the cashier
      // accepted it. Never move old cash into a replacement shift merely
      // because the physical terminal is the same.
      if (input.expectedShiftId !== undefined && shift.id !== input.expectedShiftId) {
        return fail('shift-invalid');
      }
      if (input.principal.branchId !== null && input.principal.branchId !== shift.branchId) {
        return fail('shift-invalid');
      }

      const intentHash = fingerprintCheckoutIntent(input, payment, shift.branchId);

"""
service = service[:start] + new_block + service[end:]

needle = """    const existing = await deps.sales.findByOperationId(scope, input.operationId);
    if (existing === null) {
      // Reserved but no sale: the competitor rolled back after all, or the
      // reservation belongs to something other than a completed checkout.
      // Refusing is the only safe answer — retrying could double-charge.
      return fail('idempotency-conflict');
    }
    const invoice = await deps.sales.invoiceForSale(scope, existing.id);
"""
replacement = """    const existing = await deps.sales.findByOperationId(scope, input.operationId);
    if (existing === null) {
      // Reservation and checkout sale commit in one database transaction. A
      // reserved operation with no sale is therefore unsafe to reinterpret.
      return fail('idempotency-conflict');
    }
    if (input.expectedShiftId !== undefined && existing.shiftId !== input.expectedShiftId) {
      return fail('idempotency-conflict');
    }
    const invoice = await deps.sales.invoiceForSale(scope, existing.id);
"""
if service.count(needle) != 1:
    raise SystemExit("resolveCompetingOperation block missing")
service = service.replace(needle, replacement, 1)
write(service_path, service)

# The immutable flight must preserve the shift precondition as part of the
# exact replayable request.
replace_once(
    "apps/pos-web/src/lib/checkout-flight.ts",
    "    terminalId: intent.terminalId,\n    cashReceivedMinor: intent.cashReceivedMinor,",
    "    terminalId: intent.terminalId,\n    ...(intent.expectedShiftId === undefined ? {} : { expectedShiftId: intent.expectedShiftId }),\n    cashReceivedMinor: intent.cashReceivedMinor,",
)

# Once an unanswered request is durably owned by IndexedDB, it is safe for the
# cashier to acknowledge the provisional local sale and start another basket.
replace_once(
    "apps/pos-web/src/lib/checkout.ts",
    "export type CheckoutPhase = 'idle' | 'submitting' | 'succeeded' | 'failed';",
    "export type CheckoutPhase = 'idle' | 'submitting' | 'queued' | 'succeeded' | 'failed';",
)
replace_once(
    "apps/pos-web/src/lib/checkout.ts",
    "  | { readonly type: 'succeeded'; readonly sale: SaleSummary; readonly replayed: boolean }\n  | { readonly type: 'failed'; readonly failure: Failure }",
    "  | { readonly type: 'queued'; readonly intent: CheckoutIntent }\n  | { readonly type: 'succeeded'; readonly sale: SaleSummary; readonly replayed: boolean }\n  | { readonly type: 'failed'; readonly failure: Failure }",
)
replace_once(
    "apps/pos-web/src/lib/checkout.ts",
    "    case 'succeeded':\n      return {",
    "    case 'queued':\n      return {\n        ...state,\n        phase: 'queued',\n        intent: event.intent,\n        attemptOutstanding: false,\n        sale: null,\n        replayed: false,\n        failure: null,\n      };\n    case 'succeeded':\n      return {",
)
replace_once(
    "apps/pos-web/src/lib/checkout.ts",
    "    state.phase === 'submitting' ||\n    state.phase === 'succeeded' ||",
    "    state.phase === 'submitting' ||\n    state.phase === 'queued' ||\n    state.phase === 'succeeded' ||",
)
replace_once(
    "apps/pos-web/src/lib/checkout.ts",
    "  return state.phase === 'submitting' || state.phase === 'succeeded' || state.attemptOutstanding;",
    "  return (\n    state.phase === 'submitting' ||\n    state.phase === 'queued' ||\n    state.phase === 'succeeded' ||\n    state.attemptOutstanding\n  );",
)

# Transfer an ambiguous HTTP attempt to the queue only after its exact command
# is durable. If both network and IndexedDB fail the flight stays locked.
replace_once(
    "apps/pos-web/src/lib/checkout-submit.ts",
    "export interface CheckoutSubmission {\n  readonly terminalId: string;\n  readonly lines: readonly CartLine[];",
    "export interface CheckoutSubmission {\n  readonly terminalId: string;\n  readonly expectedShiftId?: string;\n  readonly lines: readonly CartLine[];",
)
replace_once(
    "apps/pos-web/src/lib/checkout-submit.ts",
    "export interface CheckoutRunner {\n  checkout(intent: CheckoutIntent): Promise<CheckoutResponse>;\n}\n",
    "export interface CheckoutRunner {\n  checkout(intent: CheckoutIntent): Promise<CheckoutResponse>;\n}\n\nexport type AmbiguousCheckoutQueue = (intent: CheckoutIntent) => Promise<void>;\n\nconst OFFLINE_QUEUE_UNAVAILABLE = {\n  code: 'offline-queue-unavailable',\n  message:\n    'تعذّر حفظ العملية المعلّقة محلياً. لا تبدأ بيعاً جديداً؛ أعد المحاولة بنفس العملية حتى يتأكد وضعها.',\n  action: 'retry-same',\n} as const;\n",
)
replace_once(
    "apps/pos-web/src/lib/checkout-submit.ts",
    "  onUnauthenticated: () => void,\n  mint: () => string = newId,\n): Promise<void> {",
    "  onUnauthenticated: () => void,\n  mint: () => string = newId,\n  queueAmbiguous?: AmbiguousCheckoutQueue,\n): Promise<void> {",
)
replace_once(
    "apps/pos-web/src/lib/checkout-submit.ts",
    "    terminalId: input.terminalId,\n    cashReceivedMinor: input.cashReceivedMinor,",
    "    terminalId: input.terminalId,\n    ...(input.expectedShiftId === undefined ? {} : { expectedShiftId: input.expectedShiftId }),\n    cashReceivedMinor: input.cashReceivedMinor,",
)
old_catch = """    .catch((error: unknown) => {
      const failure = describeFailure(error);
      if (failure.action === 'reauthenticate') {
        flight.reset();
        onUnauthenticated();
        return;
      }
      flight.settle(outcomeFor(failure.action));
      dispatch({ type: 'failed', failure });
    });
"""
new_catch = """    .catch(async (error: unknown) => {
      const failure = describeFailure(error);
      if (failure.action === 'reauthenticate') {
        flight.reset();
        onUnauthenticated();
        return;
      }
      if (failure.action === 'retry-same' && queueAmbiguous !== undefined) {
        try {
          await queueAmbiguous(intent);
          flight.reset();
          dispatch({ type: 'queued', intent });
          return;
        } catch {
          flight.settle('ambiguous');
          dispatch({ type: 'failed', failure: OFFLINE_QUEUE_UNAVAILABLE });
          return;
        }
      }
      flight.settle(outcomeFor(failure.action));
      dispatch({ type: 'failed', failure });
    });
"""
replace_once("apps/pos-web/src/lib/checkout-submit.ts", old_catch, new_catch)

# Rejected queue commands are immutable reconciliation evidence, not trash.
replace_once(
    "apps/pos-web/src/lib/offline-store.ts",
    "  queueCount(partition: QueuePartition): Promise<number>;\n  describe(): OfflineStoreDescription;",
    "  queueCount(partition: QueuePartition): Promise<number>;\n  rejected(partition: QueuePartition, limit?: number): Promise<readonly QueuedOperation[]>;\n  describe(): OfflineStoreDescription;",
)
store_path = "apps/pos-web/src/lib/offline-store.ts"
store = read(store_path)
marker2 = "function validateClaimRequest(request: QueueClaimRequest): number {"
if store.count(marker2) != 1:
    raise SystemExit("offline store claim marker missing")
rejected_fn = """async function listRejectedQueuedOperations(
  database: IDBDatabase,
  partition: QueuePartition,
  limit: number,
): Promise<readonly QueuedOperation[]> {
  const partitionKey = queuePartitionKey(partition);
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), MAX_QUEUE_READ);
  const transaction = database.transaction(OFFLINE_TRANSACTION_QUEUE_STORE, 'readonly');
  const done = transactionDone(transaction);
  const index = transaction.objectStore(OFFLINE_TRANSACTION_QUEUE_STORE).index(QUEUE_ORDER_INDEX);
  const range = IDBKeyRange.bound([partitionKey, ''], [partitionKey, '\\uffff']);
  const request = index.openCursor(range, 'next');
  const operations: QueuedOperation[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(classifyIndexedDbError(request.error));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor === null || operations.length >= bounded) {
          resolve();
          return;
        }
        try {
          const operation = decodeStoredQueueRow(cursor.value, partition).operation;
          if (operation.state === 'rejected') operations.push(operation);
          if (operations.length >= bounded) {
            resolve();
            return;
          }
          cursor.continue();
        } catch (error) {
          transaction.abort();
          reject(classifyIndexedDbError(error));
        }
      };
    });
    await done;
    return operations;
  } catch (error) {
    await done.catch(() => undefined);
    throw classifyIndexedDbError(error);
  }
}

"""
store = store.replace(marker2, rejected_fn + marker2, 1)
method_marker = "    async queueCount(partition) {"
idx = store.find(method_marker)
if idx < 0:
    raise SystemExit("queueCount method marker missing")
store = (
    store[:idx]
    + "    async rejected(partition, limit = 100) {\n      return listRejectedQueuedOperations(database, partition, limit);\n    },\n\n"
    + store[idx:]
)
write(store_path, store)

# Exact offline checkout adapter. Money/tax/stock never become browser authority.
write(
    "apps/pos-web/src/lib/offline-checkout.ts",
    r'''import { isUuidV7, type QueueOperationInput, type QueuePartition, type SyncPushReport } from '@korvi/domain';
import type { ApiClient } from './api';
import type { CheckoutRequest } from './api-types';
import type { CheckoutIntent } from './checkout-flight';
import { createCheckoutSyncExecutor, isCheckoutQueuePayload } from './checkout-sync-executor';
import {
  OfflineStoreError,
  openKorviOfflineStore,
  type KorviOfflineStore,
} from './offline-store';
import { createQueuePushSyncEngine } from './sync-engine';

export interface OfflineSaleReviewCase {
  readonly operationId: string;
  readonly enqueuedAt: string;
  readonly attempts: number;
  readonly reason: string;
  readonly intent: CheckoutRequest;
  readonly disposition: 'needs-review';
}

export interface OfflineCheckoutSyncSnapshot {
  readonly report: SyncPushReport;
  readonly pendingCount: number;
  readonly needsReview: readonly OfflineSaleReviewCase[];
}

type OpenStore = () => Promise<KorviOfflineStore>;

/** UUIDv7 embeds its Unix millisecond timestamp in the first 48 bits. */
export function uuidV7EnqueuedAt(id: string): string {
  if (!isUuidV7(id)) throw new OfflineStoreError('corrupt', 'Checkout operation id is not UUIDv7.');
  const milliseconds = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new OfflineStoreError('corrupt', 'Checkout UUIDv7 timestamp is invalid.');
  }
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) {
    throw new OfflineStoreError('corrupt', 'Checkout UUIDv7 timestamp is outside Date range.');
  }
  return date.toISOString();
}

export function checkoutQueueOperation(intent: CheckoutIntent): QueueOperationInput<CheckoutRequest> {
  if (intent.expectedShiftId === undefined || !isUuidV7(intent.expectedShiftId)) {
    throw new OfflineStoreError(
      'corrupt',
      'Offline checkout must be pinned to the server-authorized shift that captured the cash.',
    );
  }
  const payload: CheckoutRequest = {
    operationId: intent.operationId,
    terminalId: intent.terminalId,
    expectedShiftId: intent.expectedShiftId,
    cashReceivedMinor: intent.cashReceivedMinor,
    lines: intent.lines.map((line) => ({ ...line })),
  };
  if (!isCheckoutQueuePayload(payload)) {
    throw new OfflineStoreError('corrupt', 'Refusing to queue an invalid checkout intent.');
  }
  return {
    id: intent.operationId,
    kind: 'sale.checkout',
    payload,
    enqueuedAt: uuidV7EnqueuedAt(intent.operationId),
  };
}

export async function enqueueOfflineCheckout(
  partition: QueuePartition,
  intent: CheckoutIntent,
  openStore: OpenStore = () => openKorviOfflineStore(),
): Promise<void> {
  const store = await openStore();
  try {
    await store.enqueue(partition, checkoutQueueOperation(intent));
  } finally {
    store.close();
  }
}

/**
 * Reconcile queued checkout intents against the real server authority.
 * There is deliberately no keep-local financial path. Server acceptance
 * settles; definitive refusal stays immutable and becomes needs-review.
 */
export async function syncOfflineCheckouts(
  api: ApiClient,
  partition: QueuePartition,
  onUnauthenticated?: () => void,
  openStore: OpenStore = () => openKorviOfflineStore(),
): Promise<OfflineCheckoutSyncSnapshot> {
  const store = await openStore();
  try {
    const engine = createQueuePushSyncEngine(
      store,
      partition,
      createCheckoutSyncExecutor(api, { onUnauthenticated }),
    );
    const report = await engine.push();
    const pending = await store.pending(partition, 500);
    const rejected = await store.rejected(partition, 500);
    const needsReview: OfflineSaleReviewCase[] = [];
    for (const operation of rejected) {
      if (operation.kind !== 'sale.checkout') continue;
      if (!isCheckoutQueuePayload(operation.payload) || operation.rejectionReason === null) {
        throw new OfflineStoreError('corrupt', 'Rejected checkout reconciliation evidence is corrupt.');
      }
      needsReview.push({
        operationId: operation.id,
        enqueuedAt: operation.enqueuedAt,
        attempts: operation.attempts,
        reason: operation.rejectionReason,
        intent: operation.payload,
        disposition: 'needs-review',
      });
    }
    return { report, pendingCount: pending.length, needsReview };
  } finally {
    store.close();
  }
}
''',
)

# Exact replay validator mirrors the server's required offline precondition and
# 200-line API bound.
replace_once(
    "apps/pos-web/src/lib/checkout-sync-executor.ts",
    "    typeof value.terminalId !== 'string' ||\n    !isUuidV7(value.terminalId) ||\n    typeof value.cashReceivedMinor !== 'string' ||",
    "    typeof value.terminalId !== 'string' ||\n    !isUuidV7(value.terminalId) ||\n    typeof value.expectedShiftId !== 'string' ||\n    !isUuidV7(value.expectedShiftId) ||\n    typeof value.cashReceivedMinor !== 'string' ||",
)
replace_once(
    "apps/pos-web/src/lib/checkout-sync-executor.ts",
    "    value.lines.length > 500",
    "    value.lines.length > 200",
)
replace_once(
    "apps/pos-web/src/lib/checkout-sync-executor.ts",
    "export function createCheckoutSyncExecutor(api: ApiClient): SyncOperationExecutor {",
    "export interface CheckoutSyncExecutorOptions {\n  readonly onUnauthenticated?: (() => void) | undefined;\n}\n\nexport function createCheckoutSyncExecutor(\n  api: ApiClient,\n  options: CheckoutSyncExecutorOptions = {},\n): SyncOperationExecutor {",
)
replace_once(
    "apps/pos-web/src/lib/checkout-sync-executor.ts",
    "        if (failure.action === 'retry-same' || failure.action === 'reauthenticate') {\n          return { outcome: 'retry', reason: failure.code } as const;\n        }",
    "        if (failure.action === 'reauthenticate') {\n          options.onUnauthenticated?.();\n          return { outcome: 'retry', reason: failure.code } as const;\n        }\n        if (failure.action === 'retry-same') {\n          return { outcome: 'retry', reason: failure.code } as const;\n        }",
)

# Production hook transfers ambiguous ownership to IndexedDB when a partition is supplied.
replace_once(
    "apps/pos-web/src/hooks/use-checkout.ts",
    "import { runCheckout } from '../lib/checkout-submit';",
    "import { runCheckout } from '../lib/checkout-submit';\nimport { enqueueOfflineCheckout } from '../lib/offline-checkout';\nimport type { QueuePartition } from '@korvi/domain';",
)
replace_once(
    "apps/pos-web/src/hooks/use-checkout.ts",
    "    readonly terminalId: string;\n    readonly lines: readonly CartLine[];",
    "    readonly terminalId: string;\n    readonly expectedShiftId: string;\n    readonly lines: readonly CartLine[];",
)
replace_once(
    "apps/pos-web/src/hooks/use-checkout.ts",
    "export function useCheckout(api: ApiClient, onUnauthenticated: () => void): CheckoutHandle {",
    "export function useCheckout(\n  api: ApiClient,\n  onUnauthenticated: () => void,\n  offlinePartition?: QueuePartition,\n): CheckoutHandle {",
)
replace_once(
    "apps/pos-web/src/hooks/use-checkout.ts",
    "      readonly terminalId: string;\n      readonly lines: readonly CartLine[];",
    "      readonly terminalId: string;\n      readonly expectedShiftId: string;\n      readonly lines: readonly CartLine[];",
)
replace_once(
    "apps/pos-web/src/hooks/use-checkout.ts",
    "      void runCheckout(api, owned, input, dispatch, onUnauthenticated);",
    "      void runCheckout(\n        api,\n        owned,\n        input,\n        dispatch,\n        onUnauthenticated,\n        undefined,\n        offlinePartition === undefined\n          ? undefined\n          : (intent) => enqueueOfflineCheckout(offlinePartition, intent),\n      );",
)
replace_once(
    "apps/pos-web/src/hooks/use-checkout.ts",
    "    [api, onUnauthenticated],",
    "    [api, offlinePartition, onUnauthenticated],",
)

write(
    "apps/pos-web/src/hooks/use-offline-sale-sync.ts",
    """'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { QueuePartition } from '@korvi/domain';
import type { ApiClient } from '../lib/api';
import { syncOfflineCheckouts, type OfflineSaleReviewCase } from '../lib/offline-checkout';

export interface OfflineSaleSyncState {
  readonly status: 'idle' | 'syncing' | 'ready' | 'failed';
  readonly pendingCount: number;
  readonly needsReview: readonly OfflineSaleReviewCase[];
}

const INITIAL: OfflineSaleSyncState = { status: 'idle', pendingCount: 0, needsReview: [] };

export function useOfflineSaleSync(
  api: ApiClient,
  partition: QueuePartition,
  onUnauthenticated: () => void,
): { readonly state: OfflineSaleSyncState; readonly retry: () => void } {
  const [state, setState] = useState<OfflineSaleSyncState>(INITIAL);
  const running = useRef(false);
  const mounted = useRef(true);

  const run = useCallback(() => {
    if (running.current) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    running.current = true;
    setState((current) => ({ ...current, status: 'syncing' }));
    void syncOfflineCheckouts(api, partition, onUnauthenticated)
      .then((snapshot) => {
        if (!mounted.current) return;
        setState({
          status: 'ready',
          pendingCount: snapshot.pendingCount,
          needsReview: snapshot.needsReview,
        });
      })
      .catch(() => {
        if (!mounted.current) return;
        setState((current) => ({ ...current, status: 'failed' }));
      })
      .finally(() => {
        running.current = false;
      });
  }, [api, onUnauthenticated, partition]);

  useEffect(() => {
    mounted.current = true;
    run();
    const online = () => run();
    globalThis.addEventListener('online', online);
    const timer = globalThis.setInterval(run, 60_000);
    return () => {
      mounted.current = false;
      globalThis.removeEventListener('online', online);
      globalThis.clearInterval(timer);
    };
  }, [run]);

  return { state, retry: run };
}
""",
)

# Production cashier wiring: an offline accepted cash event is provisional until
# the server reconciles it. No tax invoice or stock/accounting success is fabricated.
replace_once(
    "apps/pos-web/src/components/cashier-screen.tsx",
    "import { CardSurface } from '@korvi/ui';",
    "import { Button, CardSurface } from '@korvi/ui';",
)
replace_once(
    "apps/pos-web/src/components/cashier-screen.tsx",
    "import { useCheckout } from '../hooks/use-checkout';",
    "import { useCheckout } from '../hooks/use-checkout';\nimport { useOfflineSaleSync } from '../hooks/use-offline-sale-sync';",
)
old_setup = """  const search = useProductSearch(productSource);
  const checkout = useCheckout(api, onExpired);
  const [cash, setCash] = useState('');
"""
new_setup = """  const search = useProductSearch(productSource);
  const queuePartition = useMemo(
    () => ({
      tenantId: principal.tenant.id,
      branchId: terminal.branchId,
      terminalId: terminal.id,
    }),
    [principal.tenant.id, terminal.branchId, terminal.id],
  );
  const checkout = useCheckout(api, onExpired, queuePartition);
  const offlineSync = useOfflineSaleSync(api, queuePartition, onExpired);
  const [cash, setCash] = useState('');
"""
replace_once("apps/pos-web/src/components/cashier-screen.tsx", old_setup, new_setup)
replace_once(
    "apps/pos-web/src/components/cashier-screen.tsx",
    "    if (checkout.state.phase === 'succeeded') {\n      clearDraft();\n      return;\n    }",
    "    if (checkout.state.phase === 'succeeded' || checkout.state.phase === 'queued') {\n      clearDraft();\n      return;\n    }",
)
replace_once(
    "apps/pos-web/src/components/cashier-screen.tsx",
    "    checkout.submit({\n      terminalId: terminal.id,\n      lines: cart.lines,",
    "    checkout.submit({\n      terminalId: terminal.id,\n      expectedShiftId: shift.id,\n      lines: cart.lines,",
)
replace_once(
    "apps/pos-web/src/components/cashier-screen.tsx",
    "          {durableState.status === 'failed' ? (\n            <StatusNote tone=\"warning\" className=\"mb-3\" live>",
    "          {offlineSync.state.needsReview.length > 0 ? (\n            <StatusNote tone=\"warning\" className=\"mb-3\" live>\n              توجد {offlineSync.state.needsReview.length} عملية بيع دون اتصال رفضها الخادم وتحتاج\n              مراجعة. لم تُحذف ولم تُحوّل إلى بيع معتمد محلياً.\n            </StatusNote>\n          ) : null}\n          {offlineSync.state.pendingCount > 0 ? (\n            <StatusNote tone=\"info\" className=\"mb-3\" live>\n              توجد {offlineSync.state.pendingCount} عملية محفوظة محلياً بانتظار التسوية مع الخادم.\n            </StatusNote>\n          ) : null}\n          {offlineSync.state.status === 'failed' ? (\n            <StatusNote tone=\"warning\" className=\"mb-3\" live>\n              تعذّرت قراءة حالة مزامنة العمليات المحلية. ستبقى العمليات في التخزين المحلي حتى إعادة\n              المحاولة.\n            </StatusNote>\n          ) : null}\n          {durableState.status === 'failed' ? (\n            <StatusNote tone=\"warning\" className=\"mb-3\" live>",
)
old_render = """          {completed === null ? (
            <CardSurface className="flex min-h-0 flex-1 flex-col p-4">
"""
new_render = """          {checkout.state.phase === 'queued' && checkout.state.intent !== null ? (
            <CardSurface className="flex min-h-0 flex-1 flex-col gap-4 p-4">
              <StatusNote tone="warning" live>
                تم حفظ البيع محلياً بنفس معرّف العملية وسيُرسل للخادم دون تغيير عند عودة الاتصال.
                هذه ليست فاتورة ضريبية معتمدة بعد؛ المخزون والضريبة والحسابات تبقى بانتظار سلطة
                الخادم.
              </StatusNote>
              <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
                <p className="font-semibold">بيع دون اتصال — محفوظ بأمان</p>
                <p className="mt-2 break-all text-muted-foreground">
                  معرّف العملية: {checkout.state.intent.operationId}
                </p>
                <p className="mt-1 text-muted-foreground">المبلغ المستلم: {cash} ر.س</p>
              </div>
              <Button size="lg" onClick={newSale}>
                بدء بيع جديد
              </Button>
            </CardSurface>
          ) : completed === null ? (
            <CardSurface className="flex min-h-0 flex-1 flex-col p-4">
"""
replace_once("apps/pos-web/src/components/cashier-screen.tsx", old_render, new_render)

# Existing executor tests now prove the replay shift precondition as well.
replace_once(
    "apps/pos-web/src/lib/__tests__/checkout-sync-executor.test.ts",
    "const TERMINAL_ID = '018f5000-0000-7000-8000-000000000002';\nconst PRODUCT_ID",
    "const TERMINAL_ID = '018f5000-0000-7000-8000-000000000002';\nconst SHIFT_ID = '018f5000-0000-7000-8000-000000000004';\nconst PRODUCT_ID",
)
replace_once(
    "apps/pos-web/src/lib/__tests__/checkout-sync-executor.test.ts",
    "  terminalId: TERMINAL_ID,\n  cashReceivedMinor: '1150',",
    "  terminalId: TERMINAL_ID,\n  expectedShiftId: SHIFT_ID,\n  cashReceivedMinor: '1150',",
)
replace_once(
    "apps/pos-web/src/lib/__tests__/checkout-sync-executor.test.ts",
    "    expect(isCheckoutQueuePayload({ ...PAYLOAD, cashReceivedMinor: '11.50' })).toBe(false);",
    "    expect(isCheckoutQueuePayload({ ...PAYLOAD, expectedShiftId: undefined })).toBe(false);\n    expect(isCheckoutQueuePayload({ ...PAYLOAD, cashReceivedMinor: '11.50' })).toBe(false);",
)

write(
    "apps/pos-web/src/lib/__tests__/offline-checkout.test.ts",
    r'''import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { createCheckoutFlight } from '../checkout-flight';
import { checkoutQueueOperation } from '../offline-checkout';
import { runCheckout } from '../checkout-submit';
import { checkoutReducer, initialCheckoutState } from '../checkout';
import type { CheckoutEvent } from '../checkout';

const OPERATION_ID = '018f5000-0001-7000-8000-000000000001';
const TERMINAL_ID = '018f5000-0000-7000-8000-000000000002';
const PRODUCT_ID = '018f5000-0000-7000-8000-000000000003';
const SHIFT_ID = '018f5000-0000-7000-8000-000000000004';

const INTENT = {
  operationId: OPERATION_ID,
  terminalId: TERMINAL_ID,
  expectedShiftId: SHIFT_ID,
  cashReceivedMinor: '1150',
  lines: [{ productId: PRODUCT_ID, quantityScaled: '1000' }],
} as const;

const CART_LINE = {
  productId: PRODUCT_ID,
  sku: 'A',
  nameAr: 'أ',
  nameEn: null,
  productType: 'unit' as const,
  unitLabel: 'حبة',
  unitPriceMinor: '1150',
  vatBasisPoints: 1500,
  quantityScaled: '1000',
};

describe('offline checkout ownership transfer', () => {
  it('derives one deterministic queue envelope from the immutable UUIDv7 intent', () => {
    const first = checkoutQueueOperation(INTENT);
    const second = checkoutQueueOperation(INTENT);
    expect(second).toEqual(first);
    expect(first.id).toBe(OPERATION_ID);
    expect(first.kind).toBe('sale.checkout');
    expect(first.payload).toEqual(INTENT);
    expect(first.enqueuedAt).toMatch(/^20\d\d-/);
  });

  it('queues an unanswered request before unlocking the till', async () => {
    const flight = createCheckoutFlight();
    const events: CheckoutEvent[] = [];
    const queued = vi.fn(async () => undefined);
    await runCheckout(
      { checkout: async () => Promise.reject(new ApiError(0, 'network', null)) },
      flight,
      {
        terminalId: TERMINAL_ID,
        expectedShiftId: SHIFT_ID,
        lines: [CART_LINE],
        cashReceivedMinor: '1150',
      },
      (event) => events.push(event),
      () => undefined,
      () => OPERATION_ID,
      queued,
    );
    expect(queued).toHaveBeenCalledTimes(1);
    expect(queued.mock.calls[0]?.[0]).toEqual(INTENT);
    expect(flight.pending()).toBeNull();
    const state = events.reduce(checkoutReducer, initialCheckoutState);
    expect(state.phase).toBe('queued');
    expect(state.attemptOutstanding).toBe(false);
    expect(state.intent).toEqual(INTENT);
  });

  it('keeps the original intent locked when local durability also fails', async () => {
    const flight = createCheckoutFlight();
    const events: CheckoutEvent[] = [];
    await runCheckout(
      { checkout: async () => Promise.reject(new ApiError(0, 'network', null)) },
      flight,
      {
        terminalId: TERMINAL_ID,
        expectedShiftId: SHIFT_ID,
        lines: [CART_LINE],
        cashReceivedMinor: '1150',
      },
      (event) => events.push(event),
      () => undefined,
      () => OPERATION_ID,
      async () => Promise.reject(new Error('IndexedDB unavailable')),
    );
    expect(flight.outstanding()).toBe(true);
    expect(flight.pending()?.operationId).toBe(OPERATION_ID);
    const state = events.reduce(checkoutReducer, initialCheckoutState);
    expect(state.phase).toBe('failed');
    expect(state.attemptOutstanding).toBe(true);
    expect(state.failure?.code).toBe('offline-queue-unavailable');
  });
});
''',
)
