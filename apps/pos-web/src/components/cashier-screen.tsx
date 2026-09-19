'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { TopBar } from './top-bar';
import { ProductPanel } from './product-panel';
import { CartPanel } from './cart-panel';
import { CheckoutPanel } from './checkout-panel';
import { SaleReceipt } from './sale-receipt';
import { PreparationTicketControl } from './preparation-ticket-control';
import { RestaurantOrderTypeControl } from './restaurant-order-type-control';
import { RestaurantTableControl } from './restaurant-table-control';
import { StatusNote } from './status-note';
import { previewCart } from '../lib/cart';
import { canOpenControlCentre } from '../lib/control-access';
import { intentLocked, signOutBlocked } from '../lib/checkout';
import { createDurableProductSource } from '../lib/offline-search-source';
import { shiftNeedsRefresh } from '../lib/shift';
import { autoAddCandidate } from '../lib/search';
import { parseSarToMinor } from '../lib/money';
import { quickServiceOrderNumber } from '../lib/quick-service';
import { preparationTicketFromIntent, preparationTicketFromSale } from '../lib/preparation-ticket';
import { uuidV7EnqueuedAt } from '../lib/offline-checkout';
import { useCart } from '../hooks/use-cart';
import { useCheckout } from '../hooks/use-checkout';
import { useOfflineSaleSync } from '../hooks/use-offline-sale-sync';
import { useDurableSaleDraft } from '../hooks/use-durable-sale-draft';
import { useProductSearch } from '../hooks/use-product-search';
import type { JSX } from 'react';
import type { PriceMode, RestaurantOrderType, Vertical } from '@korvi/domain';
import type { ApiClient } from '../lib/api';
import type {
  Principal,
  ProductSummary,
  RestaurantFloorResponse,
  ShiftSummary,
  TerminalSummary,
} from '../lib/api-types';
import type { OfflineSaleScope } from '../lib/offline-store';
import type { OfflineStoreProtector } from '../lib/offline-protection';
import type { FiscalReceiptPrinter } from '../lib/receipt-print-flight';
import type { PreparationTicketPrinter } from '../lib/preparation-ticket';

/**
 * Where a cashier spends the whole day.
 *
 * The eye moves search -> product -> cart -> total -> pay, and the layout says
 * so: the search field is the largest control on the screen and the total is
 * the largest number. Nothing else competes for attention.
 *
 * One rule governs everything below: while a checkout may or may not have
 * committed, nothing that feeds the request may change — not the basket, not a
 * quantity, not the cash, not the search box, and not the session. The retry
 * has to be able to resend the same intent, and an edited field would make it
 * a different one.
 */
export interface CashierScreenProps {
  readonly api: ApiClient;
  readonly principal: Principal;
  readonly terminal: TerminalSummary;
  /** The drawer this till is selling through. The server re-checks it anyway. */
  readonly shift: ShiftSummary;
  /** From tenant_settings, by way of GET /v1/terminals. Never guessed here. */
  readonly priceMode: PriceMode;
  readonly vertical?: Vertical;
  readonly enableProductImages?: boolean;
  /** Host-owned Control destination. Installed Cashier omits it. */
  readonly controlCentreHref?: string | undefined;
  /** Stable OS/server enrollment identity used only to partition installed durable state. */
  readonly offlineStoreDeviceEnrollmentId?: string | undefined;
  readonly offlineStoreProtector?: OfflineStoreProtector | undefined;
  /** Downstream host capability. It receives only an already-finalized server receipt. */
  readonly printFiscalReceipt?: FiscalReceiptPrinter | undefined;
  readonly printPreparationTicket?: PreparationTicketPrinter | undefined;
  readonly onSignOut: () => void;
  readonly onExpired: () => void;
  readonly onShiftChanged: () => void;
}

export function CashierScreen({
  api,
  principal,
  terminal,
  shift,
  priceMode,
  vertical = 'retail',
  enableProductImages = false,
  controlCentreHref,
  offlineStoreDeviceEnrollmentId,
  offlineStoreProtector,
  printFiscalReceipt,
  printPreparationTicket,
  onSignOut,
  onExpired,
  onShiftChanged,
}: CashierScreenProps): JSX.Element {
  const cart = useCart();
  const productSource = useMemo(
    () => createDurableProductSource(api, principal.tenant.id),
    [api, principal.tenant.id],
  );
  const search = useProductSearch(productSource);
  const queuePartition = useMemo(
    () => ({
      tenantId: principal.tenant.id,
      branchId: terminal.branchId,
      terminalId: terminal.id,
      ...(offlineStoreDeviceEnrollmentId === undefined
        ? {}
        : { deviceEnrollmentId: offlineStoreDeviceEnrollmentId }),
    }),
    [offlineStoreDeviceEnrollmentId, principal.tenant.id, terminal.branchId, terminal.id],
  );
  const checkout = useCheckout(api, onExpired, queuePartition, offlineStoreProtector);
  const offlineSync = useOfflineSaleSync(api, queuePartition, onExpired, offlineStoreProtector);
  const [cash, setCash] = useState('');
  const quickService = vertical === 'restaurant';
  const [orderType, setOrderType] = useState<RestaurantOrderType>('takeaway');
  const [tableId, setTableId] = useState<string | null>(null);
  const [restaurantFloor, setRestaurantFloor] = useState<RestaurantFloorResponse | null>(null);
  const [restaurantFloorStatus, setRestaurantFloorStatus] = useState<
    'loading' | 'ready' | 'failed'
  >(quickService ? 'loading' : 'ready');
  const [draftHydrated, setDraftHydrated] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const cashInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!quickService) {
      setRestaurantFloor(null);
      setRestaurantFloorStatus('ready');
      return;
    }

    const controller = new AbortController();
    let live = true;
    setRestaurantFloorStatus('loading');
    void api
      .restaurantFloor({ signal: controller.signal })
      .then((floor) => {
        if (!live) return;
        setRestaurantFloor(floor);
        setRestaurantFloorStatus('ready');
      })
      .catch((error: unknown) => {
        if (!live) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRestaurantFloorStatus('failed');
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [api, quickService, terminal.branchId]);

  const durableScope = useMemo<OfflineSaleScope>(
    () => ({
      tenantId: principal.tenant.id,
      branchId: terminal.branchId,
      terminalId: terminal.id,
      ...(offlineStoreDeviceEnrollmentId === undefined
        ? {}
        : { deviceEnrollmentId: offlineStoreDeviceEnrollmentId }),
      userId: principal.user.id,
      shiftId: shift.id,
    }),
    [
      offlineStoreDeviceEnrollmentId,
      principal.tenant.id,
      principal.user.id,
      shift.id,
      terminal.branchId,
      terminal.id,
    ],
  );
  const {
    state: durableState,
    persist: persistDraft,
    clear: clearDraft,
  } = useDurableSaleDraft(durableScope, offlineStoreProtector);

  const preview = useMemo(() => previewCart(cart.lines, priceMode), [cart.lines, priceMode]);
  const parsedCash = parseSarToMinor(cash);
  const cashMinor = parsedCash.ok ? parsedCash.value : null;
  const durabilityLoading = !draftHydrated;
  const locked = intentLocked(checkout.state) || durabilityLoading;
  const outstanding = checkout.state.attemptOutstanding;

  const focusSearch = useCallback(() => {
    searchInput.current?.focus();
  }, []);

  useEffect(() => {
    setDraftHydrated(false);
  }, [durableScope]);

  useEffect(() => {
    if (draftHydrated || durableState.status === 'loading') return;
    if (durableState.status === 'ready' && durableState.draft !== null) {
      cart.dispatch({ type: 'replace', lines: durableState.draft.lines });
      setCash(durableState.draft.cash);
      if (durableState.draft.orderType !== undefined) setOrderType(durableState.draft.orderType);
      if (durableState.draft.tableId !== undefined) setTableId(durableState.draft.tableId);
    }
    setDraftHydrated(true);
  }, [cart.dispatch, draftHydrated, durableState]);

  useEffect(() => {
    if (!draftHydrated || durableState.status !== 'ready') return;
    if (checkout.state.phase === 'succeeded' || checkout.state.phase === 'queued') {
      clearDraft();
      return;
    }
    if (cart.lines.length === 0 && cash === '') {
      clearDraft();
      return;
    }
    persistDraft({
      lines: cart.lines,
      cash,
      ...(quickService ? { orderType } : {}),
      ...(quickService && orderType === 'dine-in' && tableId !== null ? { tableId } : {}),
      priceMode,
      updatedAt: new Date().toISOString(),
    });
  }, [
    cart.lines,
    cash,
    checkout.state.phase,
    clearDraft,
    draftHydrated,
    durableState.status,
    persistDraft,
    priceMode,
    quickService,
    orderType,
    tableId,
  ]);

  const browse = search.browse;
  useEffect(() => {
    browse();
  }, [browse]);

  const add = useCallback(
    (product: ProductSummary) => {
      if (locked) return;
      cart.dispatch({ type: 'add', product });
      search.reset();
      focusSearch();
    },
    [cart, search, locked, focusSearch],
  );

  const submitTerm = useCallback(() => {
    if (locked) return;
    const candidate = autoAddCandidate(search.state);
    if (candidate !== null) {
      add(candidate);
      return;
    }
    search.runNow(search.term);
  }, [search, add, locked]);

  useEffect(() => {
    if (shiftNeedsRefresh(checkout.state.failure?.action)) onShiftChanged();
  }, [checkout.state.failure, onShiftChanged]);

  useEffect(() => {
    if (checkout.state.failure?.action === 'amend-cash') cashInput.current?.focus();
  }, [checkout.state.failure]);

  const newSale = useCallback(() => {
    clearDraft();
    checkout.newSale();
    cart.dispatch({ type: 'clear' });
    setCash('');
    setOrderType('takeaway');
    setTableId(null);
    search.browse();
    focusSearch();
  }, [checkout, cart, clearDraft, search, focusSearch]);

  const submit = useCallback(() => {
    if (cashMinor === null) return;
    checkout.submit({
      terminalId: terminal.id,
      expectedShiftId: shift.id,
      ...(quickService ? { orderType } : {}),
      ...(quickService && orderType === 'dine-in' && tableId !== null ? { tableId } : {}),
      lines: cart.lines,
      cashReceivedMinor: cashMinor,
    });
  }, [checkout, terminal.id, shift.id, quickService, orderType, tableId, cart.lines, cashMinor]);

  const selectedRestaurantTable =
    tableId === null
      ? null
      : (restaurantFloor?.tables.find((table) => table.id === tableId) ?? null);
  const tableSubmissionBlocker =
    !quickService || orderType !== 'dine-in'
      ? null
      : tableId !== null
        ? restaurantFloorStatus === 'ready' && selectedRestaurantTable === null
          ? 'الطاولة المحددة لم تعد فعّالة في هذا الفرع. اختر طاولة أخرى.'
          : null
        : restaurantFloorStatus === 'loading'
          ? 'جاري تحميل الطاولات قبل إتمام الطلب المحلي.'
          : restaurantFloorStatus === 'failed'
            ? 'تعذّر تحميل الطاولات. أعد الاتصال قبل بدء طلب محلي جديد.'
            : 'اختر الطاولة قبل إتمام الطلب المحلي.';

  const completed = checkout.state.phase === 'succeeded' ? checkout.state.sale : null;
  const orderOperationId = completed?.operationId ?? checkout.state.intent?.operationId ?? null;
  const orderNumber =
    quickService && orderOperationId !== null
      ? quickServiceOrderNumber(orderOperationId, terminal.code)
      : null;
  const preparationTicket = useMemo(() => {
    if (!quickService || orderNumber === null) return null;
    if (completed !== null) {
      return preparationTicketFromSale(completed, cart.lines, orderNumber);
    }
    if (checkout.state.phase === 'queued' && checkout.state.intent !== null) {
      return preparationTicketFromIntent(
        checkout.state.intent,
        cart.lines,
        orderNumber,
        uuidV7EnqueuedAt(checkout.state.intent.operationId),
      );
    }
    return null;
  }, [
    cart.lines,
    checkout.state.intent,
    checkout.state.phase,
    completed,
    orderNumber,
    quickService,
  ]);
  const drawerLabel = `الوردية ${shift.id.slice(0, 8)}`;
  const authorizedControlHref =
    controlCentreHref !== undefined && canOpenControlCentre(principal.permissions)
      ? controlCentreHref
      : undefined;

  return (
    <div className="flex h-screen flex-col bg-muted/30">
      <TopBar
        cashierName={principal.user.displayName}
        controlCentreHref={authorizedControlHref}
        terminal={terminal}
        busy={checkout.state.phase === 'submitting'}
        signOutBlocked={signOutBlocked(checkout.state)}
        onSignOut={onSignOut}
      />

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 sm:gap-4 sm:p-4 lg:grid-cols-[minmax(0,1fr)_28rem] lg:overflow-hidden xl:grid-cols-[minmax(0,1fr)_30rem]">
        <CardSurface className="flex min-h-[28rem] flex-col border-border/80 bg-card p-3 shadow-sm sm:p-4 lg:min-h-0">
          {offlineSync.state.needsReview.length > 0 ? (
            <StatusNote tone="warning" className="mb-3" live>
              توجد {offlineSync.state.needsReview.length} عملية بيع دون اتصال رفضها الخادم وتحتاج
              مراجعة. لم تُحذف ولم تُحوّل إلى بيع معتمد محلياً.
            </StatusNote>
          ) : null}
          {offlineSync.state.pendingCount > 0 ? (
            <StatusNote tone="info" className="mb-3" live>
              توجد {offlineSync.state.pendingCount} عملية محفوظة محلياً بانتظار التسوية مع الخادم.
            </StatusNote>
          ) : null}
          {offlineSync.state.status === 'failed' ? (
            <StatusNote tone="warning" className="mb-3" live>
              تعذّرت قراءة حالة مزامنة العمليات المحلية. ستبقى العمليات في التخزين المحلي حتى إعادة
              المحاولة.
            </StatusNote>
          ) : null}
          {durableState.status === 'failed' ? (
            <StatusNote tone="warning" className="mb-3" live>
              التخزين المحلي غير متاح. البيع المتصل يعمل، لكن لا تعتمد على استعادة السلة بعد إغلاق
              الصفحة.
            </StatusNote>
          ) : null}
          <ProductPanel
            term={search.term}
            state={search.state}
            disabled={locked}
            inputRef={searchInput}
            onTermChange={search.setTerm}
            onSubmitTerm={submitTerm}
            onPick={add}
            quickService={quickService}
            enableImages={enableProductImages}
          />
        </CardSurface>

        <aside
          className="flex min-h-[28rem] w-full min-w-0 flex-col lg:min-h-0"
          aria-label={`السلة والدفع — ${drawerLabel}`}
        >
          {checkout.state.phase === 'queued' && checkout.state.intent !== null ? (
            <CardSurface className="flex min-h-0 flex-1 flex-col gap-4 border-border/80 p-4 shadow-sm">
              <StatusNote tone="warning" live>
                تم حفظ البيع محلياً بنفس معرّف العملية وسيُرسل للخادم دون تغيير عند عودة الاتصال.
                هذه ليست فاتورة ضريبية معتمدة بعد؛ المخزون والضريبة والحسابات تبقى بانتظار سلطة
                الخادم.
              </StatusNote>
              <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
                <p className="font-semibold">بيع دون اتصال — محفوظ بأمان</p>
                {orderNumber === null ? null : (
                  <p className="mt-2 font-semibold">رقم الطلب: {orderNumber}</p>
                )}
                <p className="mt-2 break-all text-muted-foreground">
                  معرّف العملية: {checkout.state.intent.operationId}
                </p>
                <p className="mt-1 text-muted-foreground">المبلغ المستلم: {cash} ر.س</p>
              </div>
              {preparationTicket === null ? null : (
                <PreparationTicketControl
                  ticket={preparationTicket}
                  printer={printPreparationTicket}
                />
              )}
              <Button size="lg" className="h-touch-lg font-semibold" onClick={newSale}>
                بدء بيع جديد
              </Button>
            </CardSurface>
          ) : completed === null ? (
            <CardSurface className="flex min-h-0 flex-1 flex-col border-border/80 p-4 shadow-sm">
              {durabilityLoading ? (
                <StatusNote tone="info" className="mb-3" live>
                  جاري استعادة حالة البيع المحلية…
                </StatusNote>
              ) : null}
              {outstanding ? (
                <StatusNote tone="warning" className="mb-3" live>
                  العملية معلّقة ولم تُحسم. السلة والمبلغ مقفلان حتى تُعاد بنفس العملية.
                </StatusNote>
              ) : null}
              {quickService ? (
                <RestaurantOrderTypeControl
                  value={orderType}
                  disabled={locked}
                  onChange={(value) => {
                    setOrderType(value);
                    if (value !== 'dine-in') setTableId(null);
                  }}
                />
              ) : null}
              {quickService && orderType === 'dine-in' ? (
                <RestaurantTableControl
                  floor={restaurantFloor}
                  status={restaurantFloorStatus}
                  value={tableId}
                  disabled={locked}
                  onChange={setTableId}
                />
              ) : null}
              <CartPanel
                lines={cart.lines}
                preview={preview}
                locked={locked}
                quickService={quickService}
                dispatch={cart.dispatch}
              />
              <CheckoutPanel
                totalMinor={preview.total.minor.toString()}
                netMinor={preview.net.minor.toString()}
                vatMinor={preview.vat.minor.toString()}
                cash={cash}
                cashMinor={cashMinor}
                lineCount={cart.lines.length}
                locked={locked}
                submissionBlocker={tableSubmissionBlocker}
                state={checkout.state}
                cashRef={cashInput}
                onCashChange={setCash}
                onSubmit={submit}
                onDismiss={checkout.dismiss}
              />
            </CardSurface>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <SaleReceipt
                sale={completed}
                receipt={checkout.state.receipt}
                replayed={checkout.state.replayed}
                orderNumber={orderNumber}
                printFiscalReceipt={printFiscalReceipt}
                onNewSale={newSale}
              />
              {preparationTicket === null ? null : (
                <PreparationTicketControl
                  ticket={preparationTicket}
                  printer={printPreparationTicket}
                />
              )}
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
