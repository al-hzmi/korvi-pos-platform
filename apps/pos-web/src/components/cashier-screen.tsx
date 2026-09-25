'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { newId } from '@korvi/domain';
import { Button, CardSurface } from '@korvi/ui';
import { TopBar } from './top-bar';
import { ProductPanel } from './product-panel';
import { CartPanel } from './cart-panel';
import { CashierReturnWorkflow } from './cashier-return-workflow';
import { NoReceiptExchangeWorkflow } from './no-receipt-exchange-workflow';
import { CheckoutPanel } from './checkout-panel';
import { SaleReceipt } from './sale-receipt';
import { ShiftCloseControl } from './shift-close-control';
import { PreparationTicketControl } from './preparation-ticket-control';
import { RestaurantOrderTypeControl } from './restaurant-order-type-control';
import { RestaurantOpenOrdersControl } from './restaurant-open-orders-control';
import { RestaurantTableControl } from './restaurant-table-control';
import { StatusNote } from './status-note';
import { previewCart } from '../lib/cart';
import { canOpenControlCentre } from '../lib/control-access';
import { intentLocked, signOutBlocked } from '../lib/checkout';
import { createDurableProductSource } from '../lib/offline-search-source';
import { shiftNeedsRefresh } from '../lib/shift';
import { autoAddCandidate } from '../lib/search';
import { describeFailure } from '../lib/failures';
import {
  emptyElectronicTender,
  planPayment,
  type ElectronicTenderDraft,
  type PaymentMode,
} from '../lib/payment-tenders';
import {
  cartLinesFromRestaurantOrder,
  restaurantOrderCreateLinesFromCart,
  restaurantOrderLinesFromCart,
  restaurantOrderMatchesCart,
} from '../lib/restaurant-orders';
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
  CheckoutPreviewResponse,
  RestaurantFloorResponse,
  RestaurantOrderCancelRequest,
  RestaurantOrderCreateRequest,
  RestaurantOrderDetail,
  RestaurantOrderReplaceLinesRequest,
  RestaurantOrderSummary,
  RestaurantOrderTransferTableRequest,
  RestaurantPreparationFireRequest,
  ShiftSummary,
  TerminalSummary,
} from '../lib/api-types';
import type { OfflineSaleScope } from '../lib/offline-store';
import type { OfflineStoreProtector } from '../lib/offline-protection';
import type { FiscalReceiptPrinter } from '../lib/receipt-print-flight';
import type { PreparationTicketPrinter } from '../lib/preparation-ticket';
import type { ActiveRestaurantOrder } from '../lib/restaurant-orders';

type PendingRestaurantOrderCommand =
  | { readonly kind: 'create'; readonly request: RestaurantOrderCreateRequest }
  | {
      readonly kind: 'replace';
      readonly orderId: string;
      readonly request: RestaurantOrderReplaceLinesRequest;
    }
  | {
      readonly kind: 'transfer-table';
      readonly orderId: string;
      readonly request: RestaurantOrderTransferTableRequest;
    }
  | {
      readonly kind: 'cancel';
      readonly orderId: string;
      readonly request: RestaurantOrderCancelRequest;
    }
  | {
      readonly kind: 'fire-preparation';
      readonly orderId: string;
      readonly request: RestaurantPreparationFireRequest;
    };

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
  const [couponCode, setCouponCode] = useState('');
  const [authoritativePricing, setAuthoritativePricing] = useState<CheckoutPreviewResponse | null>(
    null,
  );
  const [pricingStatus, setPricingStatus] = useState<
    'idle' | 'loading' | 'ready' | 'offline' | 'failed'
  >('idle');
  const [pricingNotice, setPricingNotice] = useState<string | null>(null);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [electronicTenders, setElectronicTenders] = useState<readonly ElectronicTenderDraft[]>([
    emptyElectronicTender(),
  ]);
  const quickService = vertical === 'restaurant';
  const [orderType, setOrderType] = useState<RestaurantOrderType>('takeaway');
  const [tableId, setTableId] = useState<string | null>(null);
  const [restaurantFloor, setRestaurantFloor] = useState<RestaurantFloorResponse | null>(null);
  const [restaurantFloorStatus, setRestaurantFloorStatus] = useState<
    'loading' | 'ready' | 'failed'
  >(quickService ? 'loading' : 'ready');
  const [restaurantOrders, setRestaurantOrders] = useState<readonly RestaurantOrderSummary[]>([]);
  const [restaurantOrdersStatus, setRestaurantOrdersStatus] = useState<
    'loading' | 'ready' | 'failed'
  >(quickService ? 'loading' : 'ready');
  const [activeRestaurantOrder, setActiveRestaurantOrder] = useState<RestaurantOrderDetail | null>(
    null,
  );
  const [activeRestaurantOrderIdentity, setActiveRestaurantOrderIdentity] =
    useState<ActiveRestaurantOrder | null>(null);
  const [restaurantOrderRestoreStatus, setRestaurantOrderRestoreStatus] = useState<
    'idle' | 'loading' | 'ready' | 'failed'
  >('idle');
  const [restaurantOrderCommandStatus, setRestaurantOrderCommandStatus] = useState<
    'idle' | 'running' | 'ambiguous'
  >('idle');
  const [pendingRestaurantOrderCommand, setPendingRestaurantOrderCommand] =
    useState<PendingRestaurantOrderCommand | null>(null);
  const [restaurantOrderNotice, setRestaurantOrderNotice] = useState<string | null>(null);
  const [operatorCommandLocked, setOperatorCommandLocked] = useState(false);
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

  const refreshRestaurantOrders = useCallback(() => {
    if (!quickService) {
      setRestaurantOrders([]);
      setRestaurantOrdersStatus('ready');
      return;
    }
    setRestaurantOrdersStatus('loading');
    void api
      .restaurantOrders()
      .then((orders) => {
        setRestaurantOrders(orders);
        setRestaurantOrdersStatus('ready');
      })
      .catch((error: unknown) => {
        const failure = describeFailure(error);
        if (failure.action === 'reauthenticate') onExpired();
        setRestaurantOrdersStatus('failed');
      });
  }, [api, onExpired, quickService]);

  useEffect(() => {
    refreshRestaurantOrders();
  }, [refreshRestaurantOrders]);

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

  useEffect(() => {
    if (quickService || cart.lines.length === 0) {
      setAuthoritativePricing(null);
      setPricingStatus('idle');
      setPricingNotice(null);
      return;
    }

    const controller = new AbortController();
    let live = true;
    setAuthoritativePricing(null);
    setPricingStatus('loading');
    setPricingNotice(null);

    const timer = window.setTimeout(() => {
      void api
        .checkoutPreview(
          {
            lines: cart.lines.map((line) => ({
              productId: line.productId,
              quantityScaled: line.quantityScaled,
            })),
            ...(couponCode.trim() === '' ? {} : { couponCodes: [couponCode.trim()] }),
          },
          { signal: controller.signal },
        )
        .then((pricing) => {
          if (!live) return;
          setAuthoritativePricing(pricing);
          setPricingStatus('ready');
          setPricingNotice(null);
        })
        .catch((error: unknown) => {
          if (!live) return;
          const failure = describeFailure(error);
          if (failure.action === 'reauthenticate') onExpired();
          setAuthoritativePricing(null);

          const transportUnavailable = failure.code === 'network' || failure.code === 'timeout';
          if (transportUnavailable && couponCode.trim() === '') {
            setPricingStatus('offline');
            setPricingNotice(
              'تعذّر الوصول إلى تسعير الخادم. البيع النقدي فقط يمكن حفظه دون اتصال، وسيعيد الخادم التحقق من السعر والعروض قبل اعتماده.',
            );
            return;
          }

          setPricingStatus('failed');
          setPricingNotice(failure.message);
        });
    }, 250);

    return () => {
      live = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [api, cart.lines, couponCode, onExpired, quickService]);

  const effectiveTotalMinor = authoritativePricing?.totalMinor ?? preview.total.minor.toString();
  const effectiveNetMinor = authoritativePricing?.netMinor ?? preview.net.minor.toString();
  const effectiveVatMinor = authoritativePricing?.vatMinor ?? preview.vat.minor.toString();
  const effectivePromotionDiscountMinor = authoritativePricing?.promotionDiscountMinor ?? '0';

  const payment = useMemo(
    () => planPayment(effectiveTotalMinor, paymentMode, cash, electronicTenders),
    [cash, effectiveTotalMinor, electronicTenders, paymentMode],
  );
  const durabilityLoading = !draftHydrated;
  const restaurantOrderContextBlocked =
    activeRestaurantOrderIdentity !== null && activeRestaurantOrder === null;
  const locked =
    intentLocked(checkout.state) ||
    durabilityLoading ||
    restaurantOrderContextBlocked ||
    restaurantOrderCommandStatus !== 'idle' ||
    operatorCommandLocked;
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
      setCouponCode(durableState.draft.couponCode ?? '');
      setPaymentMode(durableState.draft.paymentMode ?? 'cash');
      setElectronicTenders(
        durableState.draft.electronicTenders === undefined ||
          durableState.draft.electronicTenders.length === 0
          ? [emptyElectronicTender()]
          : durableState.draft.electronicTenders,
      );
      if (durableState.draft.orderType !== undefined) setOrderType(durableState.draft.orderType);
      if (durableState.draft.tableId !== undefined) setTableId(durableState.draft.tableId);
      if (
        durableState.draft.restaurantOrderId !== undefined &&
        durableState.draft.restaurantOrderRevision !== undefined
      ) {
        setActiveRestaurantOrderIdentity({
          id: durableState.draft.restaurantOrderId,
          revision: durableState.draft.restaurantOrderRevision,
        });
        setRestaurantOrderRestoreStatus('loading');
      }
    }
    setDraftHydrated(true);
  }, [cart.dispatch, draftHydrated, durableState]);

  useEffect(() => {
    if (
      activeRestaurantOrderIdentity === null ||
      activeRestaurantOrder !== null ||
      restaurantOrderRestoreStatus !== 'loading'
    ) {
      return;
    }
    let live = true;
    void api
      .restaurantOrder(activeRestaurantOrderIdentity.id)
      .then((order) => {
        if (!live) return;
        if (order.status !== 'open' || order.revision !== activeRestaurantOrderIdentity.revision) {
          setRestaurantOrderRestoreStatus('failed');
          setRestaurantOrderNotice(
            'تغيّر الطلب المفتوح منذ حفظ هذه السلة محلياً. أعد تحميل الطلب قبل المتابعة.',
          );
          return;
        }
        setActiveRestaurantOrder(order);
        setRestaurantOrderRestoreStatus('ready');
      })
      .catch((error: unknown) => {
        if (!live) return;
        const failure = describeFailure(error);
        if (failure.action === 'reauthenticate') onExpired();
        setRestaurantOrderRestoreStatus('failed');
        setRestaurantOrderNotice(failure.message);
      });
    return () => {
      live = false;
    };
  }, [
    activeRestaurantOrder,
    activeRestaurantOrderIdentity,
    api,
    onExpired,
    restaurantOrderRestoreStatus,
  ]);

  useEffect(() => {
    if (!draftHydrated || durableState.status !== 'ready') return;
    if (checkout.state.phase === 'succeeded' || checkout.state.phase === 'queued') {
      clearDraft();
      return;
    }
    if (
      cart.lines.length === 0 &&
      cash === '' &&
      couponCode === '' &&
      activeRestaurantOrderIdentity === null
    ) {
      clearDraft();
      return;
    }
    persistDraft({
      lines: cart.lines,
      cash,
      paymentMode,
      ...(paymentMode === 'mixed' ? { electronicTenders } : {}),
      ...(!quickService && couponCode.trim() !== '' ? { couponCode } : {}),
      ...(quickService ? { orderType } : {}),
      ...(quickService && orderType === 'dine-in' && tableId !== null ? { tableId } : {}),
      ...(activeRestaurantOrderIdentity === null
        ? {}
        : {
            restaurantOrderId: activeRestaurantOrderIdentity.id,
            restaurantOrderRevision: activeRestaurantOrderIdentity.revision,
          }),
      priceMode,
      updatedAt: new Date().toISOString(),
    });
  }, [
    cart.lines,
    cash,
    couponCode,
    paymentMode,
    electronicTenders,
    checkout.state.phase,
    clearDraft,
    draftHydrated,
    durableState.status,
    persistDraft,
    priceMode,
    quickService,
    orderType,
    tableId,
    activeRestaurantOrderIdentity,
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

  const resetRestaurantWorkspace = useCallback(() => {
    setActiveRestaurantOrder(null);
    setActiveRestaurantOrderIdentity(null);
    setRestaurantOrderRestoreStatus('idle');
    setPendingRestaurantOrderCommand(null);
    setRestaurantOrderCommandStatus('idle');
    setRestaurantOrderNotice(null);
  }, []);

  const newSale = useCallback(() => {
    clearDraft();
    checkout.newSale();
    cart.dispatch({ type: 'clear' });
    setCash('');
    setCouponCode('');
    setPaymentMode('cash');
    setElectronicTenders([emptyElectronicTender()]);
    setOrderType('takeaway');
    setTableId(null);
    resetRestaurantWorkspace();
    search.browse();
    focusSearch();
  }, [checkout, cart, clearDraft, resetRestaurantWorkspace, search, focusSearch]);

  const restaurantOrderDirty =
    activeRestaurantOrder === null
      ? activeRestaurantOrderIdentity !== null
      : !restaurantOrderMatchesCart(activeRestaurantOrder, cart.lines);

  const executeRestaurantOrderCommand = useCallback(
    async (command: PendingRestaurantOrderCommand) => {
      setPendingRestaurantOrderCommand(command);
      setRestaurantOrderCommandStatus('running');
      setRestaurantOrderNotice(null);
      try {
        if (command.kind === 'fire-preparation') {
          const fired = await api.fireRestaurantPreparation(command.orderId, command.request);
          setPendingRestaurantOrderCommand(null);
          setRestaurantOrderCommandStatus('idle');
          setRestaurantOrderNotice(
            fired.value.alreadyFired
              ? 'الطلب مرسل للمطبخ مسبقاً بهذه النسخة.'
              : `تم إرسال الطلب للمطبخ · ${String(fired.value.tasks.length)} مهمة تحضير.`,
          );
          return;
        }

        const result =
          command.kind === 'create'
            ? await api.createRestaurantOrder(command.request)
            : command.kind === 'replace'
              ? await api.replaceRestaurantOrderLines(command.orderId, command.request)
              : command.kind === 'transfer-table'
                ? await api.transferRestaurantOrderTable(command.orderId, command.request)
                : await api.cancelRestaurantOrder(command.orderId, command.request);

        setPendingRestaurantOrderCommand(null);
        setRestaurantOrderCommandStatus('idle');
        if (command.kind === 'create') {
          clearDraft();
          checkout.newSale();
          cart.dispatch({ type: 'clear' });
          setCash('');
          setPaymentMode('cash');
          setElectronicTenders([emptyElectronicTender()]);
          setOrderType('takeaway');
          setTableId(null);
          resetRestaurantWorkspace();
          setRestaurantOrderNotice(
            'تم حفظ الطلب مفتوحاً ويمكن استئنافه من أي صندوق مخوّل في الفرع.',
          );
          refreshRestaurantOrders();
          search.browse();
          focusSearch();
          return;
        }

        if (command.kind === 'cancel') {
          clearDraft();
          checkout.newSale();
          cart.dispatch({ type: 'clear' });
          setCash('');
          setPaymentMode('cash');
          setElectronicTenders([emptyElectronicTender()]);
          setOrderType('takeaway');
          setTableId(null);
          resetRestaurantWorkspace();
          setRestaurantOrderNotice('تم إلغاء الطلب وتسجيل السبب في سجل التدقيق.');
          refreshRestaurantOrders();
          search.browse();
          focusSearch();
          return;
        }

        setActiveRestaurantOrder(result.order);
        setActiveRestaurantOrderIdentity({ id: result.order.id, revision: result.order.revision });
        setRestaurantOrderRestoreStatus('ready');
        if (command.kind === 'replace') {
          cart.dispatch({ type: 'replace', lines: cartLinesFromRestaurantOrder(result.order) });
          setRestaurantOrderNotice('تم حفظ تعديلات الطلب.');
        } else {
          setTableId(result.order.tableId);
          setRestaurantOrderNotice('تم نقل الطلب إلى الطاولة الجديدة.');
        }
        refreshRestaurantOrders();
      } catch (error: unknown) {
        const failure = describeFailure(error);
        if (failure.action === 'reauthenticate') onExpired();
        if (failure.action === 'retry-same') {
          setRestaurantOrderCommandStatus('ambiguous');
          setRestaurantOrderNotice(failure.message);
          return;
        }
        setPendingRestaurantOrderCommand(null);
        setRestaurantOrderCommandStatus('idle');
        setRestaurantOrderNotice(failure.message);
      }
    },
    [
      api,
      cart,
      checkout,
      clearDraft,
      focusSearch,
      onExpired,
      refreshRestaurantOrders,
      resetRestaurantWorkspace,
      search,
    ],
  );

  const holdRestaurantOrder = useCallback(() => {
    if (!quickService || cart.lines.length === 0) return;
    const request: RestaurantOrderCreateRequest = {
      operationId: newId(),
      terminalId: terminal.id,
      orderType,
      tableId: orderType === 'dine-in' ? tableId : null,
      lines: restaurantOrderCreateLinesFromCart(cart.lines),
    };
    void executeRestaurantOrderCommand({ kind: 'create', request });
  }, [cart.lines, executeRestaurantOrderCommand, orderType, quickService, tableId, terminal.id]);

  const saveRestaurantOrder = useCallback(() => {
    if (
      activeRestaurantOrderIdentity === null ||
      activeRestaurantOrder === null ||
      cart.lines.length === 0 ||
      !restaurantOrderDirty
    ) {
      return;
    }
    const request: RestaurantOrderReplaceLinesRequest = {
      operationId: newId(),
      expectedRevision: activeRestaurantOrderIdentity.revision,
      lines: restaurantOrderLinesFromCart(cart.lines),
    };
    void executeRestaurantOrderCommand({
      kind: 'replace',
      orderId: activeRestaurantOrderIdentity.id,
      request,
    });
  }, [
    activeRestaurantOrder,
    activeRestaurantOrderIdentity,
    cart.lines,
    executeRestaurantOrderCommand,
    restaurantOrderDirty,
  ]);

  const transferRestaurantOrderTable = useCallback(
    (targetTableId: string) => {
      if (
        activeRestaurantOrderIdentity === null ||
        activeRestaurantOrder === null ||
        activeRestaurantOrder.orderType !== 'dine-in' ||
        restaurantOrderDirty ||
        targetTableId === '' ||
        targetTableId === activeRestaurantOrder.tableId
      ) {
        return;
      }
      const request: RestaurantOrderTransferTableRequest = {
        operationId: newId(),
        expectedRevision: activeRestaurantOrderIdentity.revision,
        tableId: targetTableId,
      };
      void executeRestaurantOrderCommand({
        kind: 'transfer-table',
        orderId: activeRestaurantOrderIdentity.id,
        request,
      });
    },
    [
      activeRestaurantOrder,
      activeRestaurantOrderIdentity,
      executeRestaurantOrderCommand,
      restaurantOrderDirty,
    ],
  );

  const cancelRestaurantOrder = useCallback(
    (reason: string) => {
      if (
        !principal.permissions.includes('sale.void') ||
        activeRestaurantOrderIdentity === null ||
        activeRestaurantOrder === null ||
        restaurantOrderDirty ||
        reason.trim() === ''
      ) {
        return;
      }
      const request: RestaurantOrderCancelRequest = {
        operationId: newId(),
        expectedRevision: activeRestaurantOrderIdentity.revision,
        reason: reason.trim(),
      };
      void executeRestaurantOrderCommand({
        kind: 'cancel',
        orderId: activeRestaurantOrderIdentity.id,
        request,
      });
    },
    [
      activeRestaurantOrder,
      activeRestaurantOrderIdentity,
      executeRestaurantOrderCommand,
      principal.permissions,
      restaurantOrderDirty,
    ],
  );

  const fireRestaurantPreparation = useCallback(() => {
    if (
      activeRestaurantOrderIdentity === null ||
      activeRestaurantOrder === null ||
      restaurantOrderDirty ||
      cart.lines.length === 0
    ) {
      return;
    }
    const request: RestaurantPreparationFireRequest = {
      operationId: newId(),
      expectedOrderRevision: activeRestaurantOrderIdentity.revision,
    };
    void executeRestaurantOrderCommand({
      kind: 'fire-preparation',
      orderId: activeRestaurantOrderIdentity.id,
      request,
    });
  }, [
    activeRestaurantOrder,
    activeRestaurantOrderIdentity,
    cart.lines.length,
    executeRestaurantOrderCommand,
    restaurantOrderDirty,
  ]);

  const resumeRestaurantOrder = useCallback(
    (orderId: string) => {
      if (locked || cart.lines.length > 0 || activeRestaurantOrderIdentity !== null) return;
      setRestaurantOrderCommandStatus('running');
      setRestaurantOrderNotice(null);
      void api
        .restaurantOrder(orderId)
        .then((order) => {
          if (order.status !== 'open') {
            setRestaurantOrderNotice('الطلب لم يعد مفتوحاً.');
            return;
          }
          checkout.newSale();
          clearDraft();
          cart.dispatch({ type: 'replace', lines: cartLinesFromRestaurantOrder(order) });
          setCash('');
          setPaymentMode('cash');
          setElectronicTenders([emptyElectronicTender()]);
          setOrderType(order.orderType);
          setTableId(order.tableId);
          setActiveRestaurantOrder(order);
          setActiveRestaurantOrderIdentity({ id: order.id, revision: order.revision });
          setRestaurantOrderRestoreStatus('ready');
        })
        .catch((error: unknown) => {
          const failure = describeFailure(error);
          if (failure.action === 'reauthenticate') onExpired();
          setRestaurantOrderNotice(failure.message);
        })
        .finally(() => {
          setRestaurantOrderCommandStatus('idle');
          refreshRestaurantOrders();
        });
    },
    [
      activeRestaurantOrderIdentity,
      api,
      cart,
      checkout,
      clearDraft,
      locked,
      onExpired,
      refreshRestaurantOrders,
    ],
  );

  const releaseRestaurantOrder = useCallback(() => {
    if (locked || restaurantOrderDirty) return;
    clearDraft();
    checkout.newSale();
    cart.dispatch({ type: 'clear' });
    setCash('');
    setCouponCode('');
    setPaymentMode('cash');
    setElectronicTenders([emptyElectronicTender()]);
    setOrderType('takeaway');
    setTableId(null);
    resetRestaurantWorkspace();
    search.browse();
    focusSearch();
  }, [
    cart,
    checkout,
    clearDraft,
    focusSearch,
    locked,
    resetRestaurantWorkspace,
    restaurantOrderDirty,
    search,
  ]);

  const retryRestaurantOrderCommand = useCallback(() => {
    if (pendingRestaurantOrderCommand === null) return;
    void executeRestaurantOrderCommand(pendingRestaurantOrderCommand);
  }, [executeRestaurantOrderCommand, pendingRestaurantOrderCommand]);

  const submit = useCallback(() => {
    if (!payment.valid) return;
    if (!quickService && pricingStatus !== 'ready' && pricingStatus !== 'offline') return;
    if (
      !quickService &&
      pricingStatus === 'offline' &&
      (couponCode.trim() !== '' || paymentMode !== 'cash')
    ) {
      return;
    }

    checkout.submit({
      terminalId: terminal.id,
      expectedShiftId: shift.id,
      ...(quickService ? { orderType } : {}),
      ...(quickService && orderType === 'dine-in' && tableId !== null ? { tableId } : {}),
      ...(activeRestaurantOrderIdentity === null
        ? {}
        : {
            restaurantOrderId: activeRestaurantOrderIdentity.id,
            expectedRestaurantOrderRevision: activeRestaurantOrderIdentity.revision,
          }),
      lines: cart.lines,
      ...(!quickService && couponCode.trim() !== '' ? { couponCodes: [couponCode.trim()] } : {}),
      ...(!quickService && authoritativePricing !== null
        ? { expectedPricingHash: authoritativePricing.pricingHash }
        : {}),
      ...(!quickService && pricingStatus === 'offline' ? { offlineCaptured: true as const } : {}),
      ...(paymentMode === 'cash'
        ? { cashReceivedMinor: payment.cashMinor }
        : { tenders: payment.tenders }),
    });
  }, [
    checkout,
    terminal.id,
    shift.id,
    quickService,
    orderType,
    tableId,
    activeRestaurantOrderIdentity,
    cart.lines,
    couponCode,
    authoritativePricing,
    pricingStatus,
    payment,
    paymentMode,
  ]);

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
  const restaurantOrderSubmissionBlocker =
    activeRestaurantOrderIdentity === null
      ? null
      : activeRestaurantOrder === null
        ? (restaurantOrderNotice ?? 'جاري التحقق من النسخة المحفوظة للطلب.')
        : restaurantOrderDirty
          ? 'احفظ تعديلات الطلب المفتوح قبل إتمام الدفع.'
          : null;
  const pricingSubmissionBlocker =
    quickService || cart.lines.length === 0
      ? null
      : pricingStatus === 'ready'
        ? null
        : pricingStatus === 'offline' && couponCode.trim() === '' && paymentMode === 'cash'
          ? null
          : (pricingNotice ??
            (pricingStatus === 'loading'
              ? 'جاري التحقق من السعر والعروض على الخادم.'
              : 'تعذّر التحقق من السعر والعروض. أعد الاتصال قبل إتمام هذا الدفع.'));
  const submissionBlocker =
    restaurantOrderSubmissionBlocker ?? tableSubmissionBlocker ?? pricingSubmissionBlocker;

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
        busy={checkout.state.phase === 'submitting' || operatorCommandLocked}
        signOutBlocked={signOutBlocked(checkout.state) || operatorCommandLocked}
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
          <div className="mb-3 flex flex-wrap gap-2">
            <CashierReturnWorkflow
              api={api}
              terminalId={terminal.id}
              canRefund={principal.permissions.includes('sale.refund')}
              disabled={locked}
              onCommandLockChange={setOperatorCommandLocked}
              onExpired={onExpired}
              onShiftChanged={onShiftChanged}
            />
            <NoReceiptExchangeWorkflow
              api={api}
              terminalId={terminal.id}
              shiftId={shift.id}
              priceMode={priceMode}
              replacementLines={cart.lines}
              replacementTotalMinor={preview.total.minor.toString()}
              canExchange={
                !quickService && principal.permissions.includes('sale.exchange.no-receipt')
              }
              disabled={locked}
              onCommandLockChange={setOperatorCommandLocked}
              onExpired={onExpired}
              onShiftChanged={onShiftChanged}
              onCompleted={newSale}
            />
            <ShiftCloseControl
              api={api}
              terminalId={terminal.id}
              shift={shift}
              canClose={principal.permissions.includes('shift.close')}
              disabled={locked}
              onCommandLockChange={setOperatorCommandLocked}
              onExpired={onExpired}
              onClosed={onShiftChanged}
            />
          </div>
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
                <p className="mt-1 text-muted-foreground">
                  طريقة الدفع: {checkout.state.intent.tenders === undefined ? 'نقدي' : 'متعدد'}
                </p>
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
                <RestaurantOpenOrdersControl
                  orders={restaurantOrders}
                  listStatus={restaurantOrdersStatus}
                  activeIdentity={activeRestaurantOrderIdentity}
                  activeOrder={activeRestaurantOrder}
                  dirty={restaurantOrderDirty}
                  cartHasLines={cart.lines.length > 0}
                  locked={locked}
                  commandStatus={restaurantOrderCommandStatus}
                  notice={restaurantOrderNotice}
                  holdBlocker={tableSubmissionBlocker}
                  tables={restaurantFloor?.tables ?? []}
                  canCancel={principal.permissions.includes('sale.void')}
                  onRefresh={refreshRestaurantOrders}
                  onResume={resumeRestaurantOrder}
                  onHold={holdRestaurantOrder}
                  onSave={saveRestaurantOrder}
                  onRelease={releaseRestaurantOrder}
                  onTransferTable={transferRestaurantOrderTable}
                  onCancel={cancelRestaurantOrder}
                  onFirePreparation={fireRestaurantPreparation}
                  onRetry={retryRestaurantOrderCommand}
                />
              ) : null}
              {quickService ? (
                <RestaurantOrderTypeControl
                  value={orderType}
                  disabled={locked || activeRestaurantOrderIdentity !== null}
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
                  disabled={locked || activeRestaurantOrderIdentity !== null}
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
                totalMinor={effectiveTotalMinor}
                netMinor={effectiveNetMinor}
                vatMinor={effectiveVatMinor}
                promotionDiscountMinor={effectivePromotionDiscountMinor}
                cash={cash}
                showCoupon={!quickService}
                couponCode={couponCode}
                paymentMode={paymentMode}
                electronicTenders={electronicTenders}
                lineCount={cart.lines.length}
                locked={locked}
                submissionBlocker={submissionBlocker}
                state={checkout.state}
                cashRef={cashInput}
                onCashChange={setCash}
                onCouponCodeChange={setCouponCode}
                onPaymentModeChange={setPaymentMode}
                onElectronicTenderChange={(index, value) => {
                  setElectronicTenders((current) =>
                    current.map((entry, entryIndex) => (entryIndex === index ? value : entry)),
                  );
                }}
                onAddElectronicTender={() => {
                  setElectronicTenders((current) =>
                    current.length >= 7 ? current : [...current, emptyElectronicTender()],
                  );
                }}
                onRemoveElectronicTender={(index) => {
                  setElectronicTenders((current) =>
                    current.length <= 1
                      ? current
                      : current.filter((_entry, entryIndex) => entryIndex !== index),
                  );
                }}
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
