'use client';

import { useEffect, useRef, useState } from 'react';
import { newId } from '@korvi/domain';
import { BidiIsolate, Button, CardSurface, Numeric } from '@korvi/ui';
import { StatusNote } from '../status-note';
import {
  buildInventoryCommandIntent,
  describeInventoryCommandFailure,
  executeInventoryCommand,
  inventoryFlightOutcomeFor,
} from '../../lib/inventory-command';
import { createInventoryCommandFlight } from '../../lib/inventory-command-flight';
import { formatScaled } from '../../lib/quantity';
import type { FormEvent, JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type { InventoryBalanceRow, InventoryBranch } from '../../lib/api-types';
import type { InventoryCommandFailure, InventoryCommandResult } from '../../lib/inventory-command';
import type { InventoryCommandIntent } from '../../lib/inventory-command-flight';

type OperationKind = InventoryCommandIntent['kind'];

type SubmissionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'failed'; readonly failure: InventoryCommandFailure }
  | { readonly kind: 'succeeded'; readonly result: InventoryCommandResult };

function ResultQuantities({
  result,
}: {
  readonly result: InventoryCommandResult;
}): JSX.Element | null {
  if (result.kind === 'transfer') {
    const line = result.value.lines[0];
    if (line === undefined) return null;
    return (
      <>
        <span>
          رصيد المصدر: <Numeric value={formatScaled(line.sourceAfterQuantityScaled)} /> — المراجعة:{' '}
          <Numeric value={line.sourceResultRevision} />
        </span>
        <span>
          رصيد الوجهة: <Numeric value={formatScaled(line.destinationAfterQuantityScaled)} /> —
          المراجعة: <Numeric value={line.destinationResultRevision} />
        </span>
      </>
    );
  }

  const line = result.value.lines[0];
  if (line === undefined) return null;
  return (
    <span>
      الرصيد السابق: <Numeric value={formatScaled(line.beforeQuantityScaled)} /> — الرصيد الجديد:{' '}
      <Numeric value={formatScaled(line.afterQuantityScaled)} /> — المراجعة:{' '}
      <Numeric value={line.resultRevision} />
    </span>
  );
}

function ResultSummary({ result }: { readonly result: InventoryCommandResult }): JSX.Element {
  return (
    <CardSurface className="flex flex-col gap-3 p-4" role="status" aria-live="polite">
      <StatusNote tone="success">
        {result.value.replayed
          ? 'تم تأكيد الحركة المسجلة سابقًا دون تكرار أثرها.'
          : 'سُجلت حركة المخزون بنجاح.'}
      </StatusNote>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
        <span>
          المستند: <BidiIsolate>{result.value.id}</BidiIsolate>
        </span>
        <ResultQuantities result={result} />
      </div>
    </CardSurface>
  );
}

export interface InventoryOperationsProps {
  readonly api: ApiClient;
  readonly branch: InventoryBranch;
  readonly branches: readonly InventoryBranch[];
  readonly balances: readonly InventoryBalanceRow[];
  readonly refreshing: boolean;
  readonly balanceGeneration: number;
  readonly permissions: readonly string[];
  readonly onRefreshBalances: () => void;
  readonly onCommandLockChange: (locked: boolean) => void;
}

export function InventoryOperations({
  api,
  branch,
  branches,
  balances,
  refreshing,
  balanceGeneration,
  permissions,
  onRefreshBalances,
  onCommandLockChange,
}: InventoryOperationsProps): JSX.Element | null {
  const canAdjust = permissions.includes('inventory.adjust');
  const canTransfer = permissions.includes('inventory.transfer');
  const [operation, setOperation] = useState<OperationKind>(() =>
    canAdjust ? 'adjustment' : 'transfer',
  );
  const [productId, setProductId] = useState('');
  const [destinationBranchId, setDestinationBranchId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const [submission, setSubmission] = useState<SubmissionState>({ kind: 'idle' });
  const [requiredFreshGeneration, setRequiredFreshGeneration] = useState<number | null>(null);
  const flight = useRef(createInventoryCommandFlight());

  const products = balances.filter((row) => row.isActive && row.trackInventory);
  const selectedProduct = products.find((row) => row.productId === productId) ?? products[0];
  const destinations = branches.filter(
    (candidate) => candidate.isActive && candidate.id !== branch.id,
  );
  const selectedDestination =
    destinations.find((candidate) => candidate.id === destinationBranchId) ?? destinations[0];
  const awaitingFreshBalance =
    requiredFreshGeneration !== null && balanceGeneration < requiredFreshGeneration;

  useEffect(() => {
    if (requiredFreshGeneration !== null && balanceGeneration >= requiredFreshGeneration) {
      onCommandLockChange(false);
    }
  }, [balanceGeneration, onCommandLockChange, requiredFreshGeneration]);

  if (!canAdjust && !canTransfer) return null;

  const locked =
    refreshing ||
    awaitingFreshBalance ||
    submission.kind === 'running' ||
    submission.kind === 'succeeded' ||
    (submission.kind === 'failed' &&
      ['retry-same', 'blocking', 'permission', 'reauthenticate'].includes(
        submission.failure.action,
      ));

  const clearDecision = (nextOperation: OperationKind = operation): void => {
    flight.current.reset();
    setOperation(nextOperation);
    setQuantity('');
    setReason('');
    setValidation(null);
    setRequiredFreshGeneration(null);
    setSubmission({ kind: 'idle' });
    onCommandLockChange(false);
  };

  const transmit = (build: () => InventoryCommandIntent): void => {
    const intent = flight.current.begin(build);
    if (intent === null) return;
    onCommandLockChange(true);
    setSubmission({ kind: 'running' });
    setValidation(null);

    void executeInventoryCommand(api, intent)
      .then((result) => {
        flight.current.settle('succeeded');
        setRequiredFreshGeneration(null);
        setSubmission({ kind: 'succeeded', result });
        onRefreshBalances();
      })
      .catch((error: unknown) => {
        const failure = describeInventoryCommandFailure(error);
        flight.current.settle(inventoryFlightOutcomeFor(failure.action));
        setSubmission({ kind: 'failed', failure });
        if (failure.action === 'refresh-stock') {
          setRequiredFreshGeneration(balanceGeneration + 1);
          setQuantity('');
          onRefreshBalances();
        } else if (failure.action === 'edit-command') {
          onCommandLockChange(false);
        }
      });
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (selectedProduct === undefined) {
      setValidation('لا يوجد صنف نشط متتبع ضمن الأرصدة المحملة.');
      return;
    }
    const built = buildInventoryCommandIntent(
      {
        kind: operation,
        branchId: branch.id,
        destinationBranchId: selectedDestination?.id ?? null,
        product: selectedProduct,
        quantity,
        reason,
      },
      newId,
    );
    if (!built.ok) {
      setValidation(built.message);
      return;
    }
    transmit(() => built.intent);
  };

  const retrySame = (): void => {
    const pending = flight.current.pending();
    if (pending !== null) transmit(() => pending);
  };

  if (!branch.isActive) {
    return (
      <StatusNote tone="warning">
        هذا الفرع معطّل. أرصدته للقراءة التاريخية فقط ولا يمكن تسجيل حركة جديدة عليه.
      </StatusNote>
    );
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="inventory-operation-title">
      <div>
        <h2 id="inventory-operation-title" className="text-lg font-semibold text-foreground">
          تسجيل حركة مخزون
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          أدخل القرار أو الملاحظة فقط؛ الرصيد والفرق والمراجعة والنتيجة يحسبها الخادم.
        </p>
      </div>

      <CardSurface className="p-4">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          {refreshing ? (
            <StatusNote tone="info" live>
              انتظر اكتمال تحديث الرصيد قبل إرسال حركة جديدة.
            </StatusNote>
          ) : null}
          {awaitingFreshBalance && !refreshing ? (
            <StatusNote tone="danger" live>
              لم تصل قراءة رصيد جديدة من الخادم بعد. لا يمكن إعادة الحركة على نسخة قديمة.
            </StatusNote>
          ) : null}
          <fieldset className="grid gap-3 md:grid-cols-3" disabled={locked}>
            <legend className="sr-only">نوع حركة المخزون</legend>
            {canAdjust ? (
              <label className="flex min-h-touch items-center gap-2 rounded-md border border-input px-3 text-sm">
                <input
                  type="radio"
                  name="inventory-operation"
                  checked={operation === 'adjustment'}
                  onChange={() => clearDecision('adjustment')}
                />
                تسوية زيادة أو نقص
              </label>
            ) : null}
            {canAdjust ? (
              <label className="flex min-h-touch items-center gap-2 rounded-md border border-input px-3 text-sm">
                <input
                  type="radio"
                  name="inventory-operation"
                  checked={operation === 'count'}
                  onChange={() => clearDecision('count')}
                />
                جرد فعلي
              </label>
            ) : null}
            {canTransfer ? (
              <label className="flex min-h-touch items-center gap-2 rounded-md border border-input px-3 text-sm">
                <input
                  type="radio"
                  name="inventory-operation"
                  checked={operation === 'transfer'}
                  onChange={() => clearDecision('transfer')}
                />
                تحويل إلى فرع
              </label>
            ) : null}
          </fieldset>

          {products.length === 0 ? (
            <StatusNote tone="warning">
              لا يوجد صنف نشط متتبع ضمن الصفحة المحملة. حمّل أرصدة إضافية إن كانت متاحة.
            </StatusNote>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
                الصنف
                <select
                  className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
                  value={selectedProduct?.productId ?? ''}
                  disabled={locked}
                  onChange={(event) => {
                    flight.current.reset();
                    setProductId(event.target.value);
                    setQuantity('');
                    setValidation(null);
                    setSubmission({ kind: 'idle' });
                  }}
                >
                  {products.map((product) => (
                    <option key={product.productId} value={product.productId}>
                      {product.nameAr} — {product.sku}
                    </option>
                  ))}
                </select>
              </label>

              {operation === 'transfer' ? (
                <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
                  فرع الوجهة
                  <select
                    className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
                    value={selectedDestination?.id ?? ''}
                    disabled={locked || destinations.length === 0}
                    onChange={(event) => {
                      flight.current.reset();
                      setDestinationBranchId(event.target.value);
                      setValidation(null);
                      setSubmission({ kind: 'idle' });
                    }}
                  >
                    {destinations.map((destination) => (
                      <option key={destination.id} value={destination.id}>
                        {destination.nameAr} — {destination.code}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
                {operation === 'adjustment'
                  ? 'التغير (+ للزيادة، − للنقص)'
                  : operation === 'count'
                    ? 'الكمية التي جُردت فعليًا'
                    : 'الكمية المطلوب تحويلها'}
                <input
                  value={quantity}
                  onChange={(event) => {
                    flight.current.reset();
                    setQuantity(event.target.value);
                    setValidation(null);
                    setSubmission({ kind: 'idle' });
                  }}
                  disabled={locked}
                  inputMode="decimal"
                  dir="ltr"
                  placeholder={operation === 'adjustment' ? '-2 أو 1.250' : '0 أو 1.250'}
                  className="h-touch rounded-md border border-input bg-background px-3 text-start font-mono outline-none focus:ring-2 focus:ring-ring"
                />
              </label>

              <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
                {operation === 'adjustment' ? 'سبب التسوية (مطلوب)' : 'سبب الحركة (اختياري)'}
                <input
                  value={reason}
                  onChange={(event) => {
                    flight.current.reset();
                    setReason(event.target.value);
                    setValidation(null);
                    setSubmission({ kind: 'idle' });
                  }}
                  disabled={locked}
                  maxLength={200}
                  className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
            </div>
          )}

          {selectedProduct === undefined ? null : (
            <p className="text-xs text-muted-foreground">
              الرصيد المعروض: <Numeric value={formatScaled(selectedProduct.quantityScaled)} /> —
              مراجعة الخادم: <Numeric value={selectedProduct.revision} />
            </p>
          )}

          {operation === 'transfer' && destinations.length === 0 ? (
            <StatusNote tone="warning">لا يوجد فرع وجهة مفعّل ضمن الفروع المحملة.</StatusNote>
          ) : null}
          {validation === null ? null : (
            <StatusNote tone="danger" live>
              {validation}
            </StatusNote>
          )}
          {submission.kind === 'failed' ? (
            <StatusNote tone={submission.failure.action === 'blocking' ? 'danger' : 'warning'} live>
              {submission.failure.message}
            </StatusNote>
          ) : null}

          <div className="flex flex-wrap gap-3">
            {submission.kind === 'failed' && submission.failure.action === 'retry-same' ? (
              <Button type="button" loading={false} onClick={retrySame}>
                إعادة إرسال نفس العملية
              </Button>
            ) : submission.kind === 'succeeded' ? (
              <Button type="button" variant="outline" onClick={() => clearDecision()}>
                بدء حركة جديدة
              </Button>
            ) : (
              <Button
                type="submit"
                loading={submission.kind === 'running'}
                disabled={
                  locked ||
                  products.length === 0 ||
                  (operation === 'transfer' && destinations.length === 0)
                }
              >
                {operation === 'adjustment'
                  ? 'تسجيل التسوية'
                  : operation === 'count'
                    ? 'تسجيل الجرد'
                    : 'تنفيذ التحويل'}
              </Button>
            )}
          </div>
        </form>
      </CardSurface>

      {submission.kind === 'succeeded' ? <ResultSummary result={submission.result} /> : null}
    </section>
  );
}
