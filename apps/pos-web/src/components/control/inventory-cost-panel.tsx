'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { newId } from '@korvi/domain';
import { BidiIsolate, Button, CardSurface, Numeric } from '@korvi/ui';
import { StatusNote } from '../status-note';
import {
  buildCostBootstrapIntent,
  costFlightOutcomeFor,
  describeCostCommandFailure,
  executeCostCommand,
} from '../../lib/cost-command';
import { createCostCommandFlight } from '../../lib/cost-command-flight';
import { isolateLtrText } from '../../lib/bidi';
import { describeFailure } from '../../lib/failures';
import { formatMinor } from '../../lib/money';
import { formatScaled } from '../../lib/quantity';
import type { FormEvent, JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type {
  InventoryBranch,
  InventoryCostBalancePage,
  InventoryCostBalanceRow,
  InventoryCostBootstrapResult,
} from '../../lib/api-types';
import type { CostCommandFailure } from '../../lib/cost-command';
import type { CostCommandIntent } from '../../lib/cost-command-flight';
import type { Failure } from '../../lib/failures';

const PAGE_SIZE = 50;

export function costRefreshPending(requiredGeneration: number | null, generation: number): boolean {
  return requiredGeneration !== null && generation < requiredGeneration;
}

export function describeCostReadFailure(error: unknown): Failure {
  const failure = describeFailure(error);
  if (failure.code !== 'network') return failure;
  return {
    ...failure,
    message: 'تعذر الوصول إلى الخادم لتحميل حقائق تكلفة المخزون. أعد المحاولة عند عودة الاتصال.',
  };
}

export type CostBalancesState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly failure: Failure }
  | {
      readonly kind: 'ready';
      readonly page: InventoryCostBalancePage;
      readonly loadingMore: boolean;
      readonly refreshing: boolean;
      readonly generation: number;
      readonly loadFailure: Failure | null;
    };

function failureTone(failure: Failure): 'warning' | 'danger' {
  return failure.action === 'permission' ? 'warning' : 'danger';
}

function valuationLabel(row: InventoryCostBalanceRow): string {
  const known = row.knownQuantityScaled !== '0';
  const unknown = row.unknownPositiveQuantityScaled !== '0';
  if (known && unknown) return 'مختلطة';
  if (known) return 'مسجلة بالكامل للكمية الموجبة';
  if (unknown) return 'مجهولة بالكامل للكمية الموجبة';
  return 'لا توجد كمية موجبة للتقييم';
}

function CostTable({ rows }: { readonly rows: readonly InventoryCostBalanceRow[] }): JSX.Element {
  return (
    <CardSurface className="overflow-x-auto">
      <table className="w-full min-w-[68rem] text-sm">
        <caption className="sr-only">حقائق تكلفة المخزون في الفرع المحدد</caption>
        <thead>
          <tr className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
            <th scope="col" className="px-3 py-3 text-start font-medium">
              الصنف
            </th>
            <th scope="col" className="px-3 py-3 text-start font-medium">
              الرصيد الكلي
            </th>
            <th scope="col" className="px-3 py-3 text-start font-medium">
              كمية بتكلفة معروفة
            </th>
            <th scope="col" className="px-3 py-3 text-start font-medium">
              كمية موجبة مجهولة
            </th>
            <th scope="col" className="px-3 py-3 text-start font-medium">
              القيمة المعروفة (ر.س)
            </th>
            <th scope="col" className="px-3 py-3 text-start font-medium">
              الحالة
            </th>
            <th scope="col" className="px-3 py-3 text-start font-medium">
              مراجعة المخزون / التكلفة
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.productId} className="border-b border-border last:border-b-0">
              <td className="px-3 py-4 font-medium text-card-foreground">
                <span>{row.nameAr}</span>
                <BidiIsolate className="mt-1 block text-xs text-muted-foreground">
                  {row.sku}
                </BidiIsolate>
              </td>
              <td className="px-3 py-4">
                <Numeric value={formatScaled(row.quantityScaled)} />
              </td>
              <td className="px-3 py-4">
                <Numeric value={formatScaled(row.knownQuantityScaled)} />
              </td>
              <td className="px-3 py-4 font-semibold">
                <Numeric value={formatScaled(row.unknownPositiveQuantityScaled)} />
              </td>
              <td className="px-3 py-4 font-semibold">
                <Numeric value={formatMinor(row.knownValueMinor)} />
              </td>
              <td className="px-3 py-4 text-muted-foreground">{valuationLabel(row)}</td>
              <td className="px-3 py-4 text-muted-foreground">
                <Numeric value={row.stockRevision} />
                <span aria-hidden="true"> / </span>
                <Numeric value={row.costRevision} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </CardSurface>
  );
}

export function InventoryCostPanelView({
  state,
  canManageCost,
  onRetry,
  onLoadMore,
  bootstrap,
}: {
  readonly state: CostBalancesState;
  readonly canManageCost: boolean;
  readonly onRetry: () => void;
  readonly onLoadMore: () => void;
  readonly bootstrap?: JSX.Element | null;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-4" aria-labelledby="inventory-cost-title">
      <div>
        <h2 id="inventory-cost-title" className="text-lg font-semibold text-foreground">
          تقييم تكلفة المخزون
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          تعرض هذه الصفحة القيمة المسجلة والجزء المجهول كما هما؛ لا تستنتج تكلفة من سعر البيع ولا
          تحوّل المجهول إلى صفر.
        </p>
      </div>

      {state.kind === 'loading' ? (
        <p
          className="py-8 text-center text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          جارٍ تحميل حقائق التكلفة…
        </p>
      ) : null}

      {state.kind === 'failed' ? (
        <div className="flex flex-col gap-3">
          <StatusNote tone={failureTone(state.failure)} live>
            {state.failure.message}
          </StatusNote>
          <div>
            <Button variant="outline" onClick={onRetry}>
              إعادة تحميل حقائق التكلفة
            </Button>
          </div>
        </div>
      ) : null}

      {state.kind === 'ready' && state.page.rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground" role="status">
          لا توجد حقائق تكلفة مسجلة أو أصناف تشغيلية في هذا الفرع.
        </p>
      ) : null}

      {state.kind === 'ready' && state.page.rows.length > 0 ? (
        <CostTable rows={state.page.rows} />
      ) : null}

      {state.kind === 'ready' && state.loadFailure !== null ? (
        <div className="flex flex-col gap-3">
          <StatusNote tone={failureTone(state.loadFailure)} live>
            {state.loadFailure.message}
          </StatusNote>
          <div>
            <Button variant="outline" onClick={onRetry}>
              إعادة محاولة تحديث حقائق التكلفة
            </Button>
          </div>
        </div>
      ) : null}

      {state.kind === 'ready' && state.refreshing ? (
        <p className="text-center text-sm text-muted-foreground" role="status" aria-live="polite">
          جارٍ تحديث حقائق التكلفة من الخادم…
        </p>
      ) : null}

      {state.kind === 'ready' && state.page.nextCursor !== null ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            loading={state.loadingMore || state.refreshing}
            onClick={onLoadMore}
          >
            تحميل حقائق تكلفة إضافية
          </Button>
        </div>
      ) : null}

      {state.kind === 'ready' && canManageCost ? bootstrap : null}
      {state.kind === 'ready' && !canManageCost ? (
        <StatusNote tone="info">
          لديك صلاحية قراءة التكلفة دون صلاحية إنشاء تقييم مستقبلي جديد.
        </StatusNote>
      ) : null}
    </section>
  );
}

type BootstrapSubmission =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'failed'; readonly failure: CostCommandFailure }
  | {
      readonly kind: 'succeeded';
      readonly result: InventoryCostBootstrapResult;
      readonly product: InventoryCostBalanceRow;
    };

export function BootstrapResult({
  result,
  product,
}: {
  readonly result: InventoryCostBootstrapResult;
  readonly product: InventoryCostBalanceRow | undefined;
}): JSX.Element {
  return (
    <CardSurface className="flex flex-col gap-3 p-4" role="status" aria-live="polite">
      <StatusNote tone="success">
        {result.replayed
          ? 'تم تأكيد التقييم المسجل سابقًا دون تكرار أثره.'
          : 'سُجل تقييم التكلفة المستقبلي بنجاح.'}
      </StatusNote>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
        <span>
          الصنف:{' '}
          {product === undefined ? (
            <BidiIsolate>{result.productId}</BidiIsolate>
          ) : (
            <>
              {product.nameAr} — <BidiIsolate>{product.sku}</BidiIsolate> —{' '}
              <BidiIsolate>{result.productId}</BidiIsolate>
            </>
          )}
        </span>
        <span>
          الدليل: <BidiIsolate>{result.id}</BidiIsolate>
        </span>
        <span>
          الكمية التي اشتقها الخادم وقيّمها:{' '}
          <Numeric value={formatScaled(result.valuedQuantityScaled)} />
        </span>
        <span>
          مراجعة المخزون / التكلفة: <Numeric value={result.stockRevision} />
          <span aria-hidden="true"> / </span>
          <Numeric value={result.costRevision} />
        </span>
      </div>
    </CardSurface>
  );
}

export function CostBootstrapForm({
  api,
  branch,
  rows,
  refreshing,
  generation,
  workspaceLocked,
  onRefresh,
  onCommandLockAcquire,
  onCommandLockChange,
}: {
  readonly api: ApiClient;
  readonly branch: InventoryBranch;
  readonly rows: readonly InventoryCostBalanceRow[];
  readonly refreshing: boolean;
  readonly generation: number;
  readonly workspaceLocked: boolean;
  readonly onRefresh: () => void;
  readonly onCommandLockAcquire: () => boolean;
  readonly onCommandLockChange: (locked: boolean) => void;
}): JSX.Element {
  const eligible = rows.filter(
    (row) => row.isActive && row.trackInventory && row.unknownPositiveQuantityScaled !== '0',
  );
  const [productId, setProductId] = useState('');
  const [totalValue, setTotalValue] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const [submission, setSubmission] = useState<BootstrapSubmission>({ kind: 'idle' });
  const [requiredGeneration, setRequiredGeneration] = useState<number | null>(null);
  const flight = useRef(createCostCommandFlight());
  const workspaceOwned = useRef(false);
  const selected = eligible.find((row) => row.productId === productId) ?? eligible[0];
  const awaitingRefresh = costRefreshPending(requiredGeneration, generation);

  const releaseWorkspace = useCallback((): void => {
    if (!workspaceOwned.current) return;
    workspaceOwned.current = false;
    onCommandLockChange(false);
  }, [onCommandLockChange]);

  useEffect(() => {
    if (requiredGeneration !== null && generation >= requiredGeneration) {
      setRequiredGeneration(null);
      if (submission.kind === 'failed' && submission.failure.action === 'refresh-cost') {
        releaseWorkspace();
      }
    }
  }, [generation, releaseWorkspace, requiredGeneration, submission]);

  const locked =
    workspaceLocked ||
    refreshing ||
    awaitingRefresh ||
    submission.kind === 'running' ||
    submission.kind === 'succeeded' ||
    (submission.kind === 'failed' &&
      ['retry-same', 'blocking', 'permission', 'reauthenticate'].includes(
        submission.failure.action,
      ));

  const clearDecision = (): void => {
    // A successful valuation changed the row the next decision would use.
    // Keep both the result and the global command lock until a fresh read has
    // actually arrived; a failed refresh must never turn stale guidance into a
    // second valuation decision.
    if (awaitingRefresh || refreshing) return;
    flight.current.reset();
    setTotalValue('');
    setValidation(null);
    setSubmission({ kind: 'idle' });
    setRequiredGeneration(null);
    releaseWorkspace();
  };

  const transmit = (build: () => CostCommandIntent, product: InventoryCostBalanceRow): void => {
    if (!workspaceOwned.current) {
      if (!onCommandLockAcquire()) return;
      workspaceOwned.current = true;
    }
    const intent = flight.current.begin(build);
    if (intent === null) return;
    setValidation(null);
    setSubmission({ kind: 'running' });
    void executeCostCommand(api, intent)
      .then((result) => {
        flight.current.settle('succeeded');
        setRequiredGeneration(generation + 1);
        setSubmission({ kind: 'succeeded', result, product });
        onRefresh();
      })
      .catch((error: unknown) => {
        const failure = describeCostCommandFailure(error);
        flight.current.settle(costFlightOutcomeFor(failure.action));
        setSubmission({ kind: 'failed', failure });
        if (failure.action === 'refresh-cost') {
          setRequiredGeneration(generation + 1);
          setTotalValue('');
          onRefresh();
        } else if (failure.action === 'edit-command') {
          releaseWorkspace();
        }
      });
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (selected === undefined) {
      setValidation('لا توجد كمية موجبة مجهولة التكلفة ضمن الصفوف المحملة.');
      return;
    }
    const built = buildCostBootstrapIntent(
      { branchId: branch.id, product: selected, totalValue },
      newId,
    );
    if (!built.ok) {
      setValidation(built.message);
      return;
    }
    transmit(() => built.intent, selected);
  };

  const retrySame = (): void => {
    const pending = flight.current.pending();
    if (pending !== null && selected !== undefined) transmit(() => pending, selected);
  };

  if (!branch.isActive) {
    return (
      <StatusNote tone="warning">
        هذا الفرع معطّل. حقائق تكلفته للقراءة التاريخية فقط ولا يمكن إنشاء تقييم جديد عليه.
      </StatusNote>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="font-semibold text-foreground">تقييم الكمية الموجبة مجهولة التكلفة</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          أدخل إجمالي قيمة الاقتناء فقط. يشتق الخادم الكمية الحالية تحت قفل المخزون والتكلفة؛ راجع
          الكمية المؤكدة في نتيجة العملية. لا تتغير كمية المخزون أو مراجعتها بهذا الأمر.
        </p>
      </div>
      <CardSurface className="p-4">
        <form className="flex flex-col gap-4" onSubmit={submit}>
          {awaitingRefresh ? (
            <StatusNote tone="danger" live>
              لم تصل قراءة تكلفة جديدة من الخادم بعد. لا يمكن إنشاء قرار على بيانات قديمة.
            </StatusNote>
          ) : null}
          {eligible.length === 0 ? (
            <StatusNote tone="info">
              لا توجد كمية موجبة مجهولة التكلفة ضمن الصفوف المحملة.
            </StatusNote>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-2 text-sm font-medium">
                الصنف
                <select
                  className="h-touch rounded-md border border-input bg-background px-3"
                  value={selected?.productId ?? ''}
                  disabled={locked}
                  onChange={(event) => {
                    flight.current.reset();
                    setProductId(event.target.value);
                    setTotalValue('');
                    setValidation(null);
                    setSubmission({ kind: 'idle' });
                  }}
                >
                  {eligible.map((row) => (
                    <option key={row.productId} value={row.productId}>
                      {row.nameAr} — {isolateLtrText(row.sku)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-2 text-sm font-medium">
                إجمالي قيمة اقتناء الكمية المجهولة (ر.س)
                <input
                  className="h-touch rounded-md border border-input bg-background px-3 font-mono"
                  dir="ltr"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={totalValue}
                  disabled={locked}
                  onChange={(event) => {
                    flight.current.reset();
                    setTotalValue(event.target.value);
                    setValidation(null);
                    setSubmission({ kind: 'idle' });
                  }}
                />
              </label>
            </div>
          )}

          {selected === undefined ? null : (
            <p className="text-xs text-muted-foreground">
              الكمية الموجبة المجهولة في آخر قراءة:{' '}
              <Numeric value={formatScaled(selected.unknownPositiveQuantityScaled)} /> — مراجعة
              المخزون / التكلفة: <Numeric value={selected.stockRevision} />
              <span aria-hidden="true"> / </span>
              <Numeric value={selected.costRevision} />
            </p>
          )}

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
              <Button type="button" onClick={retrySame}>
                إعادة إرسال نفس التقييم
              </Button>
            ) : submission.kind === 'succeeded' ? (
              <Button
                type="button"
                variant="outline"
                disabled={awaitingRefresh || refreshing}
                onClick={clearDecision}
              >
                {awaitingRefresh || refreshing ? 'بانتظار تحديث حقائق التكلفة' : 'بدء تقييم جديد'}
              </Button>
            ) : (
              <Button
                type="submit"
                loading={submission.kind === 'running'}
                disabled={locked || eligible.length === 0}
              >
                تسجيل التقييم
              </Button>
            )}
          </div>
        </form>
      </CardSurface>

      {submission.kind === 'succeeded' ? (
        <BootstrapResult result={submission.result} product={submission.product} />
      ) : null}
    </div>
  );
}

export function InventoryCostPanel({
  api,
  branch,
  canManageCost,
  workspaceLocked,
  refreshToken,
  onCommandLockAcquire,
  onCommandLockChange,
}: {
  readonly api: ApiClient;
  readonly branch: InventoryBranch;
  readonly canManageCost: boolean;
  readonly workspaceLocked: boolean;
  /** Changes after a sibling stock command or explicit stock refresh. */
  readonly refreshToken: number;
  readonly onCommandLockAcquire: () => boolean;
  readonly onCommandLockChange: (locked: boolean) => void;
}): JSX.Element {
  const [state, setState] = useState<CostBalancesState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const more = useRef<AbortController | null>(null);

  useEffect(() => {
    more.current?.abort();
    const controller = new AbortController();
    setState((current) =>
      current.kind === 'ready'
        ? { ...current, refreshing: true, loadFailure: null }
        : { kind: 'loading' },
    );
    void api
      .inventoryCostBalances(
        { branchId: branch.id, limit: PAGE_SIZE },
        { signal: controller.signal },
      )
      .then((page) =>
        setState((current) => ({
          kind: 'ready',
          page,
          loadingMore: false,
          refreshing: false,
          generation: current.kind === 'ready' ? current.generation + 1 : 1,
          loadFailure: null,
        })),
      )
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const failure = describeCostReadFailure(error);
        setState((current) =>
          current.kind === 'ready'
            ? { ...current, refreshing: false, loadFailure: failure }
            : { kind: 'failed', failure },
        );
      });
    return () => controller.abort();
  }, [api, branch.id, refreshToken, reload]);

  useEffect(
    () => () => {
      more.current?.abort();
    },
    [],
  );

  const loadMore = useCallback(() => {
    if (
      state.kind !== 'ready' ||
      state.loadingMore ||
      state.refreshing ||
      state.page.nextCursor === null
    ) {
      return;
    }
    const cursor = state.page.nextCursor;
    const controller = new AbortController();
    more.current?.abort();
    more.current = controller;
    setState({ ...state, loadingMore: true, loadFailure: null });
    void api
      .inventoryCostBalances(
        { branchId: branch.id, limit: PAGE_SIZE, cursor },
        { signal: controller.signal },
      )
      .then((page) => {
        setState((current) => {
          if (current.kind !== 'ready' || current.page.nextCursor !== cursor) return current;
          return {
            ...current,
            page: { rows: [...current.page.rows, ...page.rows], nextCursor: page.nextCursor },
            loadingMore: false,
            loadFailure: null,
          };
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState((current) =>
          current.kind === 'ready'
            ? {
                ...current,
                loadingMore: false,
                loadFailure: describeCostReadFailure(error),
              }
            : current,
        );
      });
  }, [api, branch.id, state]);

  const refresh = useCallback(() => setReload((current) => current + 1), []);
  const bootstrap =
    state.kind === 'ready' && canManageCost ? (
      <CostBootstrapForm
        api={api}
        branch={branch}
        rows={state.page.rows}
        refreshing={state.refreshing}
        generation={state.generation}
        workspaceLocked={workspaceLocked}
        onRefresh={refresh}
        onCommandLockAcquire={onCommandLockAcquire}
        onCommandLockChange={onCommandLockChange}
      />
    ) : null;

  return (
    <InventoryCostPanelView
      state={state}
      canManageCost={canManageCost}
      onRetry={refresh}
      onLoadMore={loadMore}
      bootstrap={bootstrap}
    />
  );
}
