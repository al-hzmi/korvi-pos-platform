'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { StatusNote } from '../status-note';
import { PurchasingOperations } from './purchasing-operations';
import { describeFailure } from '../../lib/failures';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type {
  PurchaseOrderSummary,
  PurchasingBranch,
  PurchasingPage,
  PurchasingProduct,
  PurchasingSupplier,
} from '../../lib/api-types';
import type { Failure } from '../../lib/failures';

const PAGE_SIZE = 50;

export interface PurchasingPages {
  readonly branches: PurchasingPage<PurchasingBranch>;
  readonly products: PurchasingPage<PurchasingProduct>;
  readonly suppliers: PurchasingPage<PurchasingSupplier>;
  readonly orders: PurchasingPage<PurchaseOrderSummary>;
}

type PageKind = keyof PurchasingPages;

type PurchasingState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly failure: Failure }
  | {
      readonly kind: 'ready';
      readonly pages: PurchasingPages;
      readonly refreshing: boolean;
      readonly loadingMore: PageKind | null;
      readonly failure: Failure | null;
    };

function purchasingFailure(error: unknown): Failure {
  const failure = describeFailure(error);
  if (failure.code !== 'network') return failure;
  return {
    ...failure,
    message: 'تعذر الوصول إلى الخادم لتحميل بيانات المشتريات. أعد المحاولة عند عودة الاتصال.',
  };
}

function appendPage<T>(current: PurchasingPage<T>, next: PurchasingPage<T>): PurchasingPage<T> {
  return { rows: [...current.rows, ...next.rows], nextCursor: next.nextCursor };
}

export function PurchasingPanel({
  api,
  permissions,
  onCommandLockChange,
}: {
  readonly api: ApiClient;
  readonly permissions: readonly string[];
  readonly onCommandLockChange?: (locked: boolean) => void;
}): JSX.Element {
  const [state, setState] = useState<PurchasingState>({ kind: 'loading' });
  const [reload, setReload] = useState(0);
  const refreshFlight = useRef<Promise<boolean> | null>(null);
  const pageFlight = useRef(false);
  const pageController = useRef<AbortController | null>(null);

  const loadFirstPages = useCallback(
    async (signal?: AbortSignal): Promise<PurchasingPages> => {
      const options = signal === undefined ? undefined : { signal };
      const [branches, products, suppliers, orders] = await Promise.all([
        api.purchasingBranches({ limit: PAGE_SIZE }, options),
        api.purchasingProducts({ limit: PAGE_SIZE }, options),
        api.purchasingSuppliers({ limit: PAGE_SIZE }, options),
        api.purchasingOrders({ limit: PAGE_SIZE }, options),
      ]);
      return { branches, products, suppliers, orders };
    },
    [api],
  );

  useEffect(() => {
    const controller = new AbortController();
    pageController.current?.abort();
    pageFlight.current = false;
    setState({ kind: 'loading' });
    void loadFirstPages(controller.signal)
      .then((pages) => {
        setState({ kind: 'ready', pages, refreshing: false, loadingMore: null, failure: null });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ kind: 'failed', failure: purchasingFailure(error) });
      });
    return () => {
      controller.abort();
      pageController.current?.abort();
      pageFlight.current = false;
    };
  }, [loadFirstPages, reload]);

  const refresh = useCallback((): Promise<boolean> => {
    if (refreshFlight.current !== null) return refreshFlight.current;
    pageController.current?.abort();
    pageFlight.current = false;
    setState((current) =>
      current.kind === 'ready' ? { ...current, refreshing: true, failure: null } : current,
    );
    const request = loadFirstPages()
      .then((pages) => {
        setState({ kind: 'ready', pages, refreshing: false, loadingMore: null, failure: null });
        return true;
      })
      .catch((error: unknown) => {
        setState((current) =>
          current.kind === 'ready'
            ? { ...current, refreshing: false, failure: purchasingFailure(error) }
            : { kind: 'failed', failure: purchasingFailure(error) },
        );
        return false;
      })
      .finally(() => {
        refreshFlight.current = null;
      });
    refreshFlight.current = request;
    return request;
  }, [loadFirstPages]);

  const loadMore = useCallback(
    (kind: PageKind): void => {
      if (state.kind !== 'ready' || state.loadingMore !== null || pageFlight.current) return;
      const current = state.pages[kind];
      if (current.nextCursor === null) return;
      pageFlight.current = true;
      setState((current) =>
        current.kind === 'ready' && current.loadingMore === null
          ? { ...current, loadingMore: kind, failure: null }
          : current,
      );

      const query = { limit: PAGE_SIZE, cursor: current.nextCursor };
      const controller = new AbortController();
      pageController.current = controller;
      const options = { signal: controller.signal };
      const request =
        kind === 'branches'
          ? api.purchasingBranches(query, options)
          : kind === 'products'
            ? api.purchasingProducts(query, options)
            : kind === 'suppliers'
              ? api.purchasingSuppliers(query, options)
              : api.purchasingOrders(query, options);

      void request
        .then((next) => {
          setState((latest) => {
            if (latest.kind !== 'ready') return latest;
            if (kind === 'branches') {
              return {
                ...latest,
                pages: {
                  ...latest.pages,
                  branches: appendPage(
                    latest.pages.branches,
                    next as PurchasingPage<PurchasingBranch>,
                  ),
                },
                loadingMore: null,
              };
            }
            if (kind === 'products') {
              return {
                ...latest,
                pages: {
                  ...latest.pages,
                  products: appendPage(
                    latest.pages.products,
                    next as PurchasingPage<PurchasingProduct>,
                  ),
                },
                loadingMore: null,
              };
            }
            if (kind === 'suppliers') {
              return {
                ...latest,
                pages: {
                  ...latest.pages,
                  suppliers: appendPage(
                    latest.pages.suppliers,
                    next as PurchasingPage<PurchasingSupplier>,
                  ),
                },
                loadingMore: null,
              };
            }
            return {
              ...latest,
              pages: {
                ...latest.pages,
                orders: appendPage(
                  latest.pages.orders,
                  next as PurchasingPage<PurchaseOrderSummary>,
                ),
              },
              loadingMore: null,
            };
          });
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setState((latest) =>
            latest.kind === 'ready'
              ? { ...latest, loadingMore: null, failure: purchasingFailure(error) }
              : latest,
          );
        })
        .finally(() => {
          if (pageController.current === controller) {
            pageController.current = null;
            pageFlight.current = false;
          }
        });
    },
    [api, state],
  );

  if (state.kind === 'loading') {
    return (
      <p
        className="py-10 text-center text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        جارٍ تحميل الموردين وأوامر الشراء…
      </p>
    );
  }

  if (state.kind === 'failed') {
    return (
      <div className="flex flex-col gap-3">
        <StatusNote tone="danger" live>
          {state.failure.message}
        </StatusNote>
        <div>
          <Button variant="outline" onClick={() => setReload((value) => value + 1)}>
            إعادة تحميل المشتريات
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <CardSurface className="flex flex-col gap-2 p-4">
        <h2 className="text-lg font-semibold text-foreground">المشتريات والاستلام</h2>
        <p className="text-sm text-muted-foreground">
          أمر الشراء لا يغيّر المخزون. الاستلام وحده يسجل الكمية المقبولة، والخادم يشتق المتبقي
          والحالة وأثر المخزون.
        </p>
      </CardSurface>

      {state.refreshing ? (
        <StatusNote tone="info" live>
          جارٍ تحديث سجل المشتريات من الخادم…
        </StatusNote>
      ) : null}
      {state.failure === null ? null : (
        <StatusNote tone="danger" live>
          {state.failure.message}
        </StatusNote>
      )}

      <PurchasingOperations
        api={api}
        pages={state.pages}
        refreshing={state.refreshing}
        loadingMore={state.loadingMore}
        permissions={permissions}
        onRefresh={refresh}
        onLoadMore={loadMore}
        onCommandLockChange={(locked) => onCommandLockChange?.(locked)}
      />
    </div>
  );
}
