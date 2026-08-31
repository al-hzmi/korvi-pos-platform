'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BidiIsolate, Button, CardSurface, Numeric } from '@korvi/ui';
import { StatusNote } from '../status-note';
import { InventoryOperations } from './inventory-operations';
import { InventoryCostPanel } from './inventory-cost-panel';
import { describeFailure } from '../../lib/failures';
import { formatScaled } from '../../lib/quantity';
import type { JSX, ReactNode } from 'react';
import type { ApiClient } from '../../lib/api';
import type {
  InventoryBalancePage,
  InventoryBalanceRow,
  InventoryBranchPage,
} from '../../lib/api-types';
import type { Failure } from '../../lib/failures';

const PAGE_SIZE = 50;

/** Atomically claims the shared stock/cost mutation workspace before React renders. */
export function acquireInventoryCommandWorkspace(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function describeInventoryReadFailure(error: unknown): Failure {
  const failure = describeFailure(error);
  if (failure.code !== 'network') return failure;
  return {
    ...failure,
    message: 'تعذر الوصول إلى الخادم لتحميل بيانات المخزون. أعد المحاولة عند عودة الاتصال.',
  };
}

export type InventoryBranchesState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly failure: Failure }
  | {
      readonly kind: 'ready';
      readonly page: InventoryBranchPage;
      readonly loadingMore: boolean;
      readonly loadFailure: Failure | null;
    };

export type InventoryBalancesState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly branchId: string }
  | { readonly kind: 'failed'; readonly branchId: string; readonly failure: Failure }
  | {
      readonly kind: 'ready';
      readonly branchId: string;
      readonly page: InventoryBalancePage;
      readonly loadingMore: boolean;
      readonly refreshing: boolean;
      /** Increments only after a complete first-page read succeeds. */
      readonly generation: number;
      readonly loadFailure: Failure | null;
    };

interface InventoryPanelViewProps {
  readonly branches: InventoryBranchesState;
  readonly balances: InventoryBalancesState;
  readonly selectedBranchId: string | null;
  readonly onSelectBranch: (branchId: string) => void;
  readonly onRetryBranches: () => void;
  readonly onLoadMoreBranches: () => void;
  readonly onRetryBalances: () => void;
  readonly onLoadMoreBalances: () => void;
  readonly branchSelectionDisabled?: boolean;
  readonly operations?: ReactNode;
  readonly costing?: ReactNode;
}

function failureTone(failure: Failure): 'warning' | 'danger' {
  return failure.action === 'permission' ? 'warning' : 'danger';
}

function BalanceTable({ rows }: { readonly rows: readonly InventoryBalanceRow[] }): JSX.Element {
  return (
    <CardSurface className="overflow-x-auto">
      <table className="w-full min-w-[46rem] text-sm">
        <caption className="sr-only">أرصدة المخزون في الفرع المحدد</caption>
        <thead>
          <tr className="border-b border-border bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="px-3 py-3 text-start font-medium">
              الصنف
            </th>
            <th scope="col" className="px-3 py-3 text-start font-medium">
              الرمز
            </th>
            <th scope="col" className="px-3 py-3 text-start font-medium">
              النوع والوحدة
            </th>
            <th scope="col" className="px-3 py-3 text-start font-medium">
              الرصيد
            </th>
            <th scope="col" className="px-3 py-3 text-start font-medium">
              نسخة الرصيد
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.productId}
              className="border-b border-border last:border-b-0 hover:bg-accent/40"
            >
              <td className="px-3 py-4 font-medium text-card-foreground">
                <span>{row.nameAr}</span>
                {row.nameEn === null ? null : (
                  <BidiIsolate className="mt-1 block text-xs text-muted-foreground">
                    {row.nameEn}
                  </BidiIsolate>
                )}
              </td>
              <td className="px-3 py-4 text-muted-foreground">
                <BidiIsolate>{row.sku}</BidiIsolate>
              </td>
              <td className="px-3 py-4 text-muted-foreground">
                <span>{row.productType === 'weighted' ? 'بالوزن' : 'بالوحدة'}</span>
                <span aria-hidden="true"> · </span>
                <BidiIsolate>{row.unitLabel}</BidiIsolate>
              </td>
              <td className="px-3 py-4 font-semibold text-card-foreground">
                <Numeric value={formatScaled(row.quantityScaled)} />
              </td>
              <td className="px-3 py-4 text-muted-foreground">
                <Numeric value={row.revision} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </CardSurface>
  );
}

export function InventoryPanelView({
  branches,
  balances,
  selectedBranchId,
  onSelectBranch,
  onRetryBranches,
  onLoadMoreBranches,
  onRetryBalances,
  onLoadMoreBalances,
  branchSelectionDisabled = false,
  operations,
  costing,
}: InventoryPanelViewProps): JSX.Element {
  if (branches.kind === 'loading') {
    return (
      <p
        className="py-10 text-center text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        جارٍ تحميل فروع المخزون…
      </p>
    );
  }

  if (branches.kind === 'failed') {
    return (
      <div className="flex flex-col gap-3">
        <StatusNote tone={failureTone(branches.failure)} live>
          {branches.failure.message}
        </StatusNote>
        <div>
          <Button variant="outline" onClick={onRetryBranches}>
            إعادة تحميل الفروع
          </Button>
        </div>
      </div>
    );
  }

  if (branches.page.rows.length === 0 || selectedBranchId === null) {
    return (
      <StatusNote tone="warning" live>
        لا توجد فروع في المنشأة لعرض أرصدتها.
      </StatusNote>
    );
  }

  const selected =
    branches.page.rows.find((branch) => branch.id === selectedBranchId) ?? branches.page.rows[0];
  const visibleBalances =
    balances.kind === 'idle' || balances.branchId !== selectedBranchId
      ? ({ kind: 'loading', branchId: selectedBranchId } as const)
      : balances;

  return (
    <div className="flex flex-col gap-4">
      <CardSurface className="p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm font-medium text-foreground">
            الفرع
            <select
              value={selectedBranchId}
              disabled={branchSelectionDisabled}
              onChange={(event) => onSelectBranch(event.target.value)}
              className="h-touch rounded-md border border-input bg-background px-3 outline-none focus:ring-2 focus:ring-ring"
            >
              {branches.page.rows.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.nameAr}
                  {branch.isActive ? '' : ' — معطّل'}
                </option>
              ))}
            </select>
          </label>

          {branches.page.nextCursor === null ? null : (
            <Button variant="outline" loading={branches.loadingMore} onClick={onLoadMoreBranches}>
              تحميل فروع إضافية
            </Button>
          )}
        </div>

        {selected === undefined ? null : (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{selected.nameAr}</span>
            {selected.nameEn === null ? null : <BidiIsolate>{selected.nameEn}</BidiIsolate>}
            <BidiIsolate>{selected.code}</BidiIsolate>
            <span>{selected.isActive ? 'فرع مفعّل' : 'فرع معطّل — عرض تاريخي فقط'}</span>
          </div>
        )}

        {branches.loadFailure === null ? null : (
          <div className="mt-3">
            <StatusNote tone={failureTone(branches.loadFailure)} live>
              {branches.loadFailure.message}
            </StatusNote>
          </div>
        )}
      </CardSurface>

      {visibleBalances.kind === 'loading' ? (
        <p
          className="py-10 text-center text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          جارٍ تحميل أرصدة الفرع…
        </p>
      ) : null}

      {visibleBalances.kind === 'failed' ? (
        <div className="flex flex-col gap-3">
          <StatusNote tone={failureTone(visibleBalances.failure)} live>
            {visibleBalances.failure.message}
          </StatusNote>
          <div>
            <Button variant="outline" onClick={onRetryBalances}>
              إعادة تحميل الأرصدة
            </Button>
          </div>
        </div>
      ) : null}

      {visibleBalances.kind === 'ready' && visibleBalances.page.rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground" role="status">
          لا توجد أرصدة مخزون مسجلة لهذا الفرع.
        </p>
      ) : null}

      {visibleBalances.kind === 'ready' && visibleBalances.page.rows.length > 0 ? (
        <BalanceTable rows={visibleBalances.page.rows} />
      ) : null}

      {visibleBalances.kind === 'ready' && visibleBalances.loadFailure !== null ? (
        <StatusNote tone={failureTone(visibleBalances.loadFailure)} live>
          {visibleBalances.loadFailure.message}
        </StatusNote>
      ) : null}

      {visibleBalances.kind === 'ready' && visibleBalances.refreshing ? (
        <p className="text-center text-sm text-muted-foreground" role="status" aria-live="polite">
          جارٍ تحديث الأرصدة من الخادم…
        </p>
      ) : null}

      {visibleBalances.kind === 'ready' && visibleBalances.page.nextCursor !== null ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            loading={visibleBalances.loadingMore || visibleBalances.refreshing}
            onClick={onLoadMoreBalances}
          >
            تحميل أرصدة إضافية
          </Button>
        </div>
      ) : null}

      {visibleBalances.kind === 'ready' ? operations : null}
      {costing}
    </div>
  );
}

export function InventoryPanel({
  api,
  preferredBranchId,
  permissions,
  onCommandLockChange,
}: {
  readonly api: ApiClient;
  readonly preferredBranchId: string | null;
  readonly permissions: readonly string[];
  readonly onCommandLockChange?: (locked: boolean) => void;
}): JSX.Element {
  const [branches, setBranches] = useState<InventoryBranchesState>({ kind: 'loading' });
  const [balances, setBalances] = useState<InventoryBalancesState>({ kind: 'idle' });
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [branchReload, setBranchReload] = useState(0);
  const [balanceReload, setBalanceReload] = useState(0);
  const [commandLocked, setCommandLocked] = useState(false);
  const branchMore = useRef<AbortController | null>(null);
  const balanceMore = useRef<AbortController | null>(null);
  const commandLock = useRef(false);

  const setCommandLock = useCallback(
    (locked: boolean) => {
      commandLock.current = locked;
      setCommandLocked(locked);
      onCommandLockChange?.(locked);
    },
    [onCommandLockChange],
  );

  const selectBranch = useCallback((branchId: string) => {
    if (!commandLock.current) setSelectedBranchId(branchId);
  }, []);

  const acquireCommandLock = useCallback((): boolean => {
    if (!acquireInventoryCommandWorkspace(commandLock)) return false;
    setCommandLock(true);
    return true;
  }, [setCommandLock]);

  useEffect(() => {
    const controller = new AbortController();
    branchMore.current?.abort();
    setBranches({ kind: 'loading' });

    void api
      .inventoryBranches({ limit: PAGE_SIZE }, { signal: controller.signal })
      .then((page) => {
        const preferred = page.rows.find((branch) => branch.id === preferredBranchId);
        const firstActive = page.rows.find((branch) => branch.isActive);
        setBranches({ kind: 'ready', page, loadingMore: false, loadFailure: null });
        setSelectedBranchId((current) => {
          if (page.rows.some((branch) => branch.id === current)) return current;
          return preferred?.id ?? firstActive?.id ?? page.rows[0]?.id ?? null;
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setBranches({ kind: 'failed', failure: describeInventoryReadFailure(error) });
      });

    return () => controller.abort();
  }, [api, branchReload, preferredBranchId]);

  useEffect(() => {
    balanceMore.current?.abort();
    if (selectedBranchId === null) {
      setBalances({ kind: 'idle' });
      return undefined;
    }

    const controller = new AbortController();
    const branchId = selectedBranchId;
    setBalances((current) =>
      current.kind === 'ready' && current.branchId === branchId
        ? { ...current, refreshing: true, loadFailure: null }
        : { kind: 'loading', branchId },
    );
    void api
      .inventoryBalances({ branchId, limit: PAGE_SIZE }, { signal: controller.signal })
      .then((page) =>
        setBalances((current) => ({
          kind: 'ready',
          branchId,
          page,
          loadingMore: false,
          refreshing: false,
          generation:
            current.kind === 'ready' && current.branchId === branchId ? current.generation + 1 : 1,
          loadFailure: null,
        })),
      )
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const failure = describeInventoryReadFailure(error);
        setBalances((current) =>
          current.kind === 'ready' && current.branchId === branchId
            ? { ...current, refreshing: false, loadFailure: failure }
            : { kind: 'failed', branchId, failure },
        );
      });

    return () => controller.abort();
  }, [api, balanceReload, selectedBranchId]);

  useEffect(
    () => () => {
      branchMore.current?.abort();
      balanceMore.current?.abort();
    },
    [],
  );

  const loadMoreBranches = useCallback(() => {
    if (branches.kind !== 'ready' || branches.loadingMore || branches.page.nextCursor === null) {
      return;
    }
    const cursor = branches.page.nextCursor;
    const controller = new AbortController();
    branchMore.current?.abort();
    branchMore.current = controller;
    setBranches({ ...branches, loadingMore: true, loadFailure: null });

    void api
      .inventoryBranches({ limit: PAGE_SIZE, cursor }, { signal: controller.signal })
      .then((page) => {
        setBranches((current) => {
          if (current.kind !== 'ready' || current.page.nextCursor !== cursor) return current;
          return {
            kind: 'ready',
            page: { rows: [...current.page.rows, ...page.rows], nextCursor: page.nextCursor },
            loadingMore: false,
            loadFailure: null,
          };
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setBranches((current) =>
          current.kind === 'ready'
            ? {
                ...current,
                loadingMore: false,
                loadFailure: describeInventoryReadFailure(error),
              }
            : current,
        );
      });
  }, [api, branches]);

  const loadMoreBalances = useCallback(() => {
    if (
      balances.kind !== 'ready' ||
      balances.loadingMore ||
      balances.refreshing ||
      balances.page.nextCursor === null
    ) {
      return;
    }
    const branchId = balances.branchId;
    const cursor = balances.page.nextCursor;
    const controller = new AbortController();
    balanceMore.current?.abort();
    balanceMore.current = controller;
    setBalances({ ...balances, loadingMore: true, loadFailure: null });

    void api
      .inventoryBalances({ branchId, limit: PAGE_SIZE, cursor }, { signal: controller.signal })
      .then((page) => {
        setBalances((current) => {
          if (
            current.kind !== 'ready' ||
            current.branchId !== branchId ||
            current.page.nextCursor !== cursor
          ) {
            return current;
          }
          return {
            kind: 'ready',
            branchId,
            page: { rows: [...current.page.rows, ...page.rows], nextCursor: page.nextCursor },
            loadingMore: false,
            refreshing: false,
            generation: current.generation,
            loadFailure: null,
          };
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setBalances((current) =>
          current.kind === 'ready' && current.branchId === branchId
            ? {
                ...current,
                loadingMore: false,
                loadFailure: describeInventoryReadFailure(error),
              }
            : current,
        );
      });
  }, [api, balances]);

  const loadedBranches = branches.kind === 'ready' ? branches.page.rows : [];
  const selectedBranch = loadedBranches.find((branch) => branch.id === selectedBranchId);
  const operations =
    selectedBranch !== undefined &&
    balances.kind === 'ready' &&
    balances.branchId === selectedBranch.id ? (
      <InventoryOperations
        key={selectedBranch.id}
        api={api}
        branch={selectedBranch}
        branches={loadedBranches}
        balances={balances.page.rows}
        refreshing={balances.refreshing}
        balanceGeneration={balances.generation}
        workspaceLocked={commandLocked}
        permissions={permissions}
        onRefreshBalances={() => setBalanceReload((current) => current + 1)}
        onCommandLockAcquire={acquireCommandLock}
        onCommandLockChange={setCommandLock}
      />
    ) : null;
  const costing =
    selectedBranch !== undefined && permissions.includes('inventory.cost.read') ? (
      <InventoryCostPanel
        key={selectedBranch.id}
        api={api}
        branch={selectedBranch}
        canManageCost={permissions.includes('inventory.cost.manage')}
        workspaceLocked={commandLocked}
        refreshToken={balanceReload}
        onCommandLockAcquire={acquireCommandLock}
        onCommandLockChange={setCommandLock}
      />
    ) : null;

  return (
    <InventoryPanelView
      branches={branches}
      balances={balances}
      selectedBranchId={selectedBranchId}
      onSelectBranch={selectBranch}
      onRetryBranches={() => setBranchReload((current) => current + 1)}
      onLoadMoreBranches={loadMoreBranches}
      onRetryBalances={() => setBalanceReload((current) => current + 1)}
      onLoadMoreBalances={loadMoreBalances}
      branchSelectionDisabled={commandLocked}
      operations={operations}
      costing={costing}
    />
  );
}
