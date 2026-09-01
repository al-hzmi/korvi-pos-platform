'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_PURCHASING_LINES, newId } from '@korvi/domain';
import { BidiIsolate, Button, CardSurface, Numeric } from '@korvi/ui';
import { StatusNote } from '../status-note';
import {
  buildPurchaseOrderIntent,
  buildPurchaseReceiptIntent,
  buildSupplierCreateIntent,
  buildSupplierUpdateIntent,
  describePurchasingCommandFailure,
  executePurchasingCommand,
  purchasingFlightOutcomeFor,
} from '../../lib/purchasing-command';
import { createPurchasingCommandFlight } from '../../lib/purchasing-command-flight';
import { isolateLtrText } from '../../lib/bidi';
import { formatTimestamp } from '../../lib/datetime';
import { formatScaled } from '../../lib/quantity';
import type { FormEvent, JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type {
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderStatus,
  PurchaseReceiptSummary,
  PurchasingProduct,
  PurchasingSupplier,
} from '../../lib/api-types';
import type {
  PurchasingCommandFailure,
  PurchasingCommandResult,
  ReceiptInventoryValueDraft,
} from '../../lib/purchasing-command';
import type { PurchasingCommandIntent } from '../../lib/purchasing-command-flight';
import type { PurchasingPages } from './purchasing-panel';

type Workspace = 'suppliers' | 'orders' | 'receiving';
type SupplierMode = 'create' | 'update';

type SubmissionState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'failed'; readonly failure: PurchasingCommandFailure }
  | { readonly kind: 'succeeded'; readonly result: PurchasingCommandResult };

export type DetailState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly orderId: string }
  | { readonly kind: 'failed'; readonly orderId: string; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly order: PurchaseOrder;
      readonly receipts: readonly PurchaseReceiptSummary[];
    };

interface OrderLineDraft {
  readonly key: string;
  readonly productId: string;
  readonly quantity: string;
}

function statusLabel(status: PurchaseOrderStatus): string {
  if (status === 'open') return 'مفتوح';
  if (status === 'partially_received') return 'مستلم جزئيًا';
  return 'مستلم بالكامل';
}

function supplierName(suppliers: readonly PurchasingSupplier[], id: string): string {
  return suppliers.find((supplier) => supplier.id === id)?.name ?? isolateLtrText(id);
}

function productName(products: readonly PurchasingProduct[], id: string): string {
  const product = products.find((candidate) => candidate.id === id);
  return product === undefined
    ? isolateLtrText(id)
    : `${product.nameAr} — ${isolateLtrText(product.sku)}`;
}

export function resolveOrderLineProduct(
  products: readonly PurchasingProduct[],
  productId: string,
  index: number,
): PurchasingProduct | undefined {
  return products.find((product) => product.id === productId) ?? products[index] ?? products[0];
}

export function ReceiptLineEditor({
  line,
  label,
  quantity,
  inventoryValue,
  canManageCost,
  disabled,
  onQuantityChange,
  onCostEnabledChange,
  onCostValueChange,
}: {
  readonly line: PurchaseOrderLine;
  readonly label: string;
  readonly quantity: string;
  readonly inventoryValue: ReceiptInventoryValueDraft;
  readonly canManageCost: boolean;
  readonly disabled: boolean;
  readonly onQuantityChange: (value: string) => void;
  readonly onCostEnabledChange: (enabled: boolean) => void;
  readonly onCostValueChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="grid gap-3 rounded-md border border-border p-3 text-sm md:grid-cols-2 md:items-end">
      <div className="font-medium">
        <span>{label}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          المتبقي: <Numeric value={formatScaled(line.remainingQuantityScaled)} />
        </span>
      </div>
      <label className="flex flex-col gap-2 font-medium">
        الكمية المستلمة
        <input
          aria-label={`الكمية المستلمة ${label}`}
          className="h-touch rounded-md border border-input bg-background px-3 font-mono"
          dir="ltr"
          inputMode="decimal"
          disabled={disabled}
          value={quantity}
          onChange={(event) => onQuantityChange(event.target.value)}
        />
      </label>
      {canManageCost ? (
        <div className="flex flex-col gap-3 md:col-span-2">
          <label className="flex min-h-touch items-center gap-2 font-medium">
            <input
              type="checkbox"
              aria-label={`تسجيل قيمة اقتناء ${label}`}
              checked={inventoryValue.enabled}
              disabled={disabled}
              onChange={(event) => onCostEnabledChange(event.target.checked)}
            />
            تسجيل إجمالي قيمة اقتناء موثوقة لهذه الكمية
          </label>
          {inventoryValue.enabled ? (
            <label className="flex flex-col gap-2 font-medium md:max-w-md">
              إجمالي قيمة اقتناء الكمية المستلمة (ر.س)
              <input
                aria-label={`إجمالي قيمة اقتناء ${label}`}
                className="h-touch rounded-md border border-input bg-background px-3 font-mono"
                dir="ltr"
                inputMode="decimal"
                placeholder="0.00"
                disabled={disabled}
                value={inventoryValue.value}
                onChange={(event) => onCostValueChange(event.target.value)}
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SuppliersTable({
  suppliers,
}: {
  readonly suppliers: readonly PurchasingSupplier[];
}): JSX.Element {
  if (suppliers.length === 0) {
    return <StatusNote tone="info">لا يوجد موردون مسجلون حتى الآن.</StatusNote>;
  }
  return (
    <CardSurface className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <caption className="sr-only">الموردون المسجلون</caption>
        <thead>
          <tr className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
            <th className="px-3 py-3 text-start font-medium" scope="col">
              المورد
            </th>
            <th className="px-3 py-3 text-start font-medium" scope="col">
              الحالة
            </th>
            <th className="px-3 py-3 text-start font-medium" scope="col">
              آخر تحديث
            </th>
          </tr>
        </thead>
        <tbody>
          {suppliers.map((supplier) => (
            <tr key={supplier.id} className="border-b border-border last:border-b-0">
              <td className="px-3 py-3 font-medium">{supplier.name}</td>
              <td className="px-3 py-3">
                {supplier.isActive ? 'مفعّل' : 'معطّل — محفوظ تاريخيًا'}
              </td>
              <td className="px-3 py-3">
                <BidiIsolate>{formatTimestamp(supplier.updatedAt)}</BidiIsolate>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </CardSurface>
  );
}

function ResultSummary({ result }: { readonly result: PurchasingCommandResult }): JSX.Element {
  const replayed = result.value.replayed;
  const id =
    result.kind === 'supplier-create' || result.kind === 'supplier-update'
      ? result.value.supplier.id
      : result.kind === 'order-create'
        ? result.value.order.id
        : result.value.id;
  return (
    <CardSurface className="flex flex-col gap-3 p-4" role="status" aria-live="polite">
      <StatusNote tone="success">
        {replayed
          ? 'تم تأكيد العملية المسجلة سابقًا دون تكرار أثرها.'
          : result.kind === 'receipt'
            ? 'سُجل الاستلام وحركة المخزون ذريًا.'
            : 'سُجلت عملية المشتريات بنجاح.'}
      </StatusNote>
      <p className="text-sm text-muted-foreground">
        المستند: <BidiIsolate>{id}</BidiIsolate>
        {result.kind === 'receipt' ? (
          <> — حالة الأمر: {statusLabel(result.value.purchaseOrderStatus)}</>
        ) : null}
      </p>
    </CardSurface>
  );
}

function OrdersTable({
  pages,
  selectedOrderId,
  disabled,
  onSelect,
}: {
  readonly pages: PurchasingPages;
  readonly selectedOrderId: string;
  readonly disabled: boolean;
  readonly onSelect: (orderId: string) => void;
}): JSX.Element {
  if (pages.orders.rows.length === 0) {
    return <StatusNote tone="info">لا توجد أوامر شراء مسجلة حتى الآن.</StatusNote>;
  }
  return (
    <CardSurface className="overflow-x-auto">
      <table className="w-full min-w-[54rem] text-sm">
        <caption className="sr-only">أوامر الشراء المسجلة</caption>
        <thead>
          <tr className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
            <th className="px-3 py-3 text-start font-medium" scope="col">
              الأمر
            </th>
            <th className="px-3 py-3 text-start font-medium" scope="col">
              المورد
            </th>
            <th className="px-3 py-3 text-start font-medium" scope="col">
              الحالة
            </th>
            <th className="px-3 py-3 text-start font-medium" scope="col">
              البنود
            </th>
            <th className="px-3 py-3 text-start font-medium" scope="col">
              التاريخ
            </th>
            <th className="px-3 py-3 text-start font-medium" scope="col">
              عرض
            </th>
          </tr>
        </thead>
        <tbody>
          {pages.orders.rows.map((order) => (
            <tr key={order.id} className="border-b border-border last:border-b-0">
              <td className="px-3 py-3">
                <BidiIsolate>{order.reference ?? order.id}</BidiIsolate>
              </td>
              <td className="px-3 py-3">{supplierName(pages.suppliers.rows, order.supplierId)}</td>
              <td className="px-3 py-3">{statusLabel(order.status)}</td>
              <td className="px-3 py-3">
                <Numeric value={String(order.lineCount)} />
              </td>
              <td className="px-3 py-3">
                <BidiIsolate>{formatTimestamp(order.orderedAt)}</BidiIsolate>
              </td>
              <td className="px-3 py-3">
                <Button
                  type="button"
                  variant={selectedOrderId === order.id ? 'primary' : 'outline'}
                  disabled={disabled}
                  aria-pressed={selectedOrderId === order.id}
                  aria-label={`تفاصيل أمر الشراء ${isolateLtrText(order.reference ?? order.id)}`}
                  onClick={() => onSelect(order.id)}
                >
                  التفاصيل
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </CardSurface>
  );
}

export function OrderDetail({
  state,
  products,
  onRetry,
}: {
  readonly state: DetailState;
  readonly products: readonly PurchasingProduct[];
  readonly onRetry: () => void;
}): JSX.Element | null {
  if (state.kind === 'idle') return null;
  if (state.kind === 'loading') {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground" role="status">
        جارٍ تحميل تفاصيل الأمر والاستلامات…
      </p>
    );
  }
  if (state.kind === 'failed')
    return (
      <div className="flex flex-col items-start gap-3">
        <StatusNote tone="danger" live>
          {state.message}
        </StatusNote>
        <Button type="button" variant="outline" onClick={onRetry}>
          إعادة تحميل تفاصيل الأمر
        </Button>
      </div>
    );
  return (
    <CardSurface className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
        <span>
          الأمر: <BidiIsolate>{state.order.reference ?? state.order.id}</BidiIsolate>
        </span>
        <span>الحالة: {statusLabel(state.order.status)}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm">
          <caption className="sr-only">بنود أمر الشراء وكمياتها المتبقية</caption>
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="px-3 py-2 text-start font-medium" scope="col">
                الصنف
              </th>
              <th className="px-3 py-2 text-start font-medium" scope="col">
                المطلوب
              </th>
              <th className="px-3 py-2 text-start font-medium" scope="col">
                المستلم
              </th>
              <th className="px-3 py-2 text-start font-medium" scope="col">
                المتبقي
              </th>
            </tr>
          </thead>
          <tbody>
            {state.order.lines.map((line) => (
              <tr key={line.id} className="border-b border-border last:border-b-0">
                <td className="px-3 py-3">{productName(products, line.productId)}</td>
                <td className="px-3 py-3">
                  <Numeric value={formatScaled(line.orderedQuantityScaled)} />
                </td>
                <td className="px-3 py-3">
                  <Numeric value={formatScaled(line.receivedQuantityScaled)} />
                </td>
                <td className="px-3 py-3 font-semibold">
                  <Numeric value={formatScaled(line.remainingQuantityScaled)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-muted-foreground">
        الاستلامات المعروضة (بحد أقصى 100): <Numeric value={String(state.receipts.length)} />
      </p>
      {state.receipts.map((receipt) => (
        <div
          key={receipt.id}
          className="rounded-md border border-border p-3 text-sm text-muted-foreground"
        >
          <span>
            <BidiIsolate>{receipt.reference ?? receipt.id}</BidiIsolate>
          </span>
          <span aria-hidden="true"> · </span>
          <BidiIsolate>{formatTimestamp(receipt.receivedAt)}</BidiIsolate>
          <div className="mt-2 flex flex-col gap-1">
            {receipt.lines.map((line) => (
              <span key={line.id}>
                {productName(products, line.productId)}:
                <Numeric value={formatScaled(line.acceptedQuantityScaled)} />
              </span>
            ))}
          </div>
        </div>
      ))}
    </CardSurface>
  );
}

export interface PurchasingOperationsProps {
  readonly api: ApiClient;
  readonly pages: PurchasingPages;
  readonly refreshing: boolean;
  readonly loadingMore: keyof PurchasingPages | null;
  readonly permissions: readonly string[];
  readonly onRefresh: () => Promise<boolean>;
  readonly onLoadMore: (kind: keyof PurchasingPages) => void;
  readonly onCommandLockChange: (locked: boolean) => void;
}

export function PurchasingOperations({
  api,
  pages,
  refreshing,
  loadingMore,
  permissions,
  onRefresh,
  onLoadMore,
  onCommandLockChange,
}: PurchasingOperationsProps): JSX.Element {
  const canManage = permissions.includes('purchasing.manage');
  const canReceive = permissions.includes('purchasing.receive');
  const canManageCost = permissions.includes('inventory.cost.manage');
  const [workspace, setWorkspace] = useState<Workspace>(() =>
    canManage ? 'suppliers' : canReceive ? 'receiving' : 'orders',
  );
  const [supplierMode, setSupplierMode] = useState<SupplierMode>('create');
  const [supplierId, setSupplierId] = useState('');
  const [supplierDraft, setSupplierDraft] = useState('');
  const [supplierActive, setSupplierActive] = useState(true);
  const [orderSupplierId, setOrderSupplierId] = useState('');
  const [orderBranchId, setOrderBranchId] = useState('');
  const [orderReference, setOrderReference] = useState('');
  const [orderLines, setOrderLines] = useState<readonly OrderLineDraft[]>([
    { key: 'line-1', productId: '', quantity: '' },
  ]);
  const [selectedOrderId, setSelectedOrderId] = useState(
    () =>
      pages.orders.rows.find((order) => order.status !== 'received')?.id ??
      pages.orders.rows[0]?.id ??
      '',
  );
  const [detail, setDetail] = useState<DetailState>({ kind: 'idle' });
  const [receiptReference, setReceiptReference] = useState('');
  const [receiptQuantities, setReceiptQuantities] = useState<Readonly<Record<string, string>>>({});
  const [receiptInventoryValues, setReceiptInventoryValues] = useState<
    Readonly<Record<string, ReceiptInventoryValueDraft>>
  >({});
  const [validation, setValidation] = useState<string | null>(null);
  const [submission, setSubmission] = useState<SubmissionState>({ kind: 'idle' });
  const flight = useRef(createPurchasingCommandFlight());
  const nextLine = useRef(2);
  const detailController = useRef<AbortController | null>(null);

  const activeSuppliers = pages.suppliers.rows.filter((supplier) => supplier.isActive);
  const activeBranches = pages.branches.rows.filter((branch) => branch.isActive);
  const activeProducts = pages.products.rows.filter(
    (product) => product.isActive && product.trackInventory,
  );
  const selectedSupplier =
    pages.suppliers.rows.find((supplier) => supplier.id === supplierId) ?? pages.suppliers.rows[0];
  const selectedOrderSupplier =
    activeSuppliers.find((supplier) => supplier.id === orderSupplierId) ?? activeSuppliers[0];
  const selectedOrderBranch =
    activeBranches.find((branch) => branch.id === orderBranchId) ?? activeBranches[0];

  const loadDetail = useCallback(async (): Promise<boolean> => {
    if (workspace === 'suppliers' || selectedOrderId === '') {
      detailController.current?.abort();
      setDetail({ kind: 'idle' });
      return true;
    }
    const orderId = selectedOrderId;
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setDetail({ kind: 'loading', orderId });
    try {
      const [order, receipts] = await Promise.all([
        api.purchasingOrder(orderId, { signal: controller.signal }),
        api.purchasingReceipts(orderId, { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return false;
      setDetail({ kind: 'ready', order, receipts });
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return false;
      setDetail({
        kind: 'failed',
        orderId,
        message: 'تعذر تحميل تفاصيل أمر الشراء. أعد المحاولة.',
      });
      return false;
    }
  }, [api, selectedOrderId, workspace]);

  useEffect(() => {
    let active = true;
    if (workspace === 'suppliers' || selectedOrderId === '') {
      detailController.current?.abort();
      setDetail({ kind: 'idle' });
      return undefined;
    }
    const orderId = selectedOrderId;
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setDetail({ kind: 'loading', orderId });
    void Promise.all([
      api.purchasingOrder(orderId, { signal: controller.signal }),
      api.purchasingReceipts(orderId, { signal: controller.signal }),
    ])
      .then(([order, receipts]) => {
        if (active && !controller.signal.aborted) setDetail({ kind: 'ready', order, receipts });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (active)
          setDetail({
            kind: 'failed',
            orderId,
            message: 'تعذر تحميل تفاصيل أمر الشراء. أعد المحاولة.',
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, selectedOrderId, workspace]);

  const commandLocked =
    submission.kind === 'running' ||
    submission.kind === 'succeeded' ||
    (submission.kind === 'failed' &&
      ['retry-same', 'refresh-purchasing', 'blocking', 'permission', 'reauthenticate'].includes(
        submission.failure.action,
      ));
  const formLocked = refreshing || commandLocked;

  const clearDecision = (nextWorkspace: Workspace = workspace): void => {
    if (submission.kind === 'succeeded') {
      if (submission.result.kind === 'supplier-create') {
        setSupplierDraft('');
        setSupplierMode('create');
      } else if (submission.result.kind === 'supplier-update') {
        setSupplierId(submission.result.value.supplier.id);
        setSupplierDraft(submission.result.value.supplier.name);
        setSupplierActive(submission.result.value.supplier.isActive);
      } else if (submission.result.kind === 'order-create') {
        setOrderReference('');
        setOrderLines([{ key: 'line-1', productId: '', quantity: '' }]);
        nextLine.current = 2;
      }
    }
    flight.current.reset();
    setWorkspace(nextWorkspace);
    setValidation(null);
    setSubmission({ kind: 'idle' });
    setReceiptQuantities({});
    setReceiptInventoryValues({});
    setReceiptReference('');
    onCommandLockChange(false);
  };

  const reconcile = (): void => {
    onCommandLockChange(true);
    void Promise.all([onRefresh(), loadDetail()]).then(([listsReady, detailReady]) => {
      if (listsReady && detailReady) {
        setOrderSupplierId('');
        setOrderBranchId('');
        setOrderLines((current) =>
          current.map((line) => ({ ...line, productId: '', quantity: '' })),
        );
        setReceiptReference('');
        setReceiptInventoryValues({});
        setSubmission({ kind: 'idle' });
        setValidation('تم تحديث سجل المشتريات. أعد إدخال القرار على البيانات الجديدة.');
        onCommandLockChange(false);
      }
    });
  };

  const transmit = (build: () => PurchasingCommandIntent): void => {
    const intent = flight.current.begin(build);
    if (intent === null) return;
    onCommandLockChange(true);
    setValidation(null);
    setSubmission({ kind: 'running' });
    void executePurchasingCommand(api, intent)
      .then((result) => {
        flight.current.settle('succeeded');
        setSubmission({ kind: 'succeeded', result });
        if (result.kind === 'order-create') {
          setSelectedOrderId(result.value.order.id);
          setDetail({ kind: 'ready', order: result.value.order, receipts: [] });
        }
        void onRefresh();
        if (result.kind === 'receipt') void loadDetail();
      })
      .catch((error: unknown) => {
        const failure = describePurchasingCommandFailure(error);
        flight.current.settle(purchasingFlightOutcomeFor(failure.action));
        setSubmission({ kind: 'failed', failure });
        if (failure.action === 'refresh-purchasing') {
          setReceiptQuantities({});
          setReceiptInventoryValues({});
          reconcile();
        } else if (failure.action === 'edit-command') {
          onCommandLockChange(false);
        }
      });
  };

  const submitSupplier = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const built =
      supplierMode === 'create'
        ? buildSupplierCreateIntent(supplierDraft, newId)
        : selectedSupplier === undefined
          ? { ok: false as const, message: 'اختر موردًا.' }
          : buildSupplierUpdateIntent(
              {
                supplierId: selectedSupplier.id,
                name: supplierDraft,
                originalName: selectedSupplier.name,
                isActive: supplierActive,
                originalIsActive: selectedSupplier.isActive,
              },
              newId,
            );
    if (!built.ok) {
      setValidation(built.message);
      return;
    }
    transmit(() => built.intent);
  };

  const submitOrder = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const lines: { product: PurchasingProduct; quantity: string }[] = [];
    for (const [index, draft] of orderLines.entries()) {
      const product = resolveOrderLineProduct(activeProducts, draft.productId, index);
      if (product === undefined) {
        setValidation('اختر صنفًا مفعّلًا لكل بند.');
        return;
      }
      lines.push({ product, quantity: draft.quantity });
    }
    const built = buildPurchaseOrderIntent(
      {
        supplierId: selectedOrderSupplier?.id ?? '',
        branchId: selectedOrderBranch?.id ?? '',
        reference: orderReference,
        lines,
      },
      newId,
    );
    if (!built.ok) {
      setValidation(built.message);
      return;
    }
    transmit(() => built.intent);
  };

  const submitReceipt = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (detail.kind !== 'ready') {
      setValidation('حمّل تفاصيل أمر الشراء قبل الاستلام.');
      return;
    }
    const built = buildPurchaseReceiptIntent(
      {
        order: detail.order,
        reference: receiptReference,
        products: pages.products.rows,
        quantities: receiptQuantities,
        inventoryValues: receiptInventoryValues,
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

  return (
    <section className="flex flex-col gap-4" aria-labelledby="purchasing-workspace-title">
      <h2 id="purchasing-workspace-title" className="sr-only">
        مساحة عمل المشتريات
      </h2>
      <div className="grid gap-3 md:grid-cols-3">
        <Button
          type="button"
          variant={workspace === 'suppliers' ? 'primary' : 'outline'}
          disabled={commandLocked}
          aria-pressed={workspace === 'suppliers'}
          onClick={() => clearDecision('suppliers')}
        >
          الموردون
        </Button>
        <Button
          type="button"
          variant={workspace === 'orders' ? 'primary' : 'outline'}
          disabled={commandLocked}
          aria-pressed={workspace === 'orders'}
          onClick={() => clearDecision('orders')}
        >
          أوامر الشراء
        </Button>
        <Button
          type="button"
          variant={workspace === 'receiving' ? 'primary' : 'outline'}
          disabled={commandLocked}
          aria-pressed={workspace === 'receiving'}
          onClick={() => clearDecision('receiving')}
        >
          الاستلامات
        </Button>
      </div>

      {workspace === 'suppliers' && canManage ? (
        <CardSurface className="p-4">
          <form className="flex flex-col gap-4" onSubmit={submitSupplier}>
            <fieldset className="grid gap-3 md:grid-cols-2" disabled={formLocked}>
              <legend className="sr-only">عملية المورد</legend>
              <label className="flex min-h-touch items-center gap-2 rounded-md border border-input px-3 text-sm">
                <input
                  type="radio"
                  name="supplier-mode"
                  checked={supplierMode === 'create'}
                  onChange={() => {
                    flight.current.reset();
                    setSupplierMode('create');
                    setSupplierDraft('');
                    setValidation(null);
                  }}
                />
                إضافة مورد
              </label>
              <label className="flex min-h-touch items-center gap-2 rounded-md border border-input px-3 text-sm">
                <input
                  type="radio"
                  name="supplier-mode"
                  checked={supplierMode === 'update'}
                  disabled={pages.suppliers.rows.length === 0}
                  onChange={() => {
                    flight.current.reset();
                    setSupplierMode('update');
                    setSupplierDraft(selectedSupplier?.name ?? '');
                    setSupplierActive(selectedSupplier?.isActive ?? true);
                    setValidation(null);
                  }}
                />
                تعديل أو تعطيل مورد
              </label>
            </fieldset>
            {supplierMode === 'update' ? (
              <label className="flex flex-col gap-2 text-sm font-medium">
                المورد
                <select
                  className="h-touch rounded-md border border-input bg-background px-3"
                  disabled={formLocked}
                  value={selectedSupplier?.id ?? ''}
                  onChange={(event) => {
                    const supplier = pages.suppliers.rows.find(
                      (candidate) => candidate.id === event.target.value,
                    );
                    flight.current.reset();
                    setSupplierId(event.target.value);
                    setSupplierDraft(supplier?.name ?? '');
                    setSupplierActive(supplier?.isActive ?? true);
                    setValidation(null);
                  }}
                >
                  {pages.suppliers.rows.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.name}
                      {supplier.isActive ? '' : ' — معطّل'}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="flex flex-col gap-2 text-sm font-medium">
              اسم المورد
              <input
                className="h-touch rounded-md border border-input bg-background px-3"
                maxLength={160}
                disabled={formLocked}
                value={supplierDraft}
                onChange={(event) => {
                  flight.current.reset();
                  setSupplierDraft(event.target.value);
                  setValidation(null);
                }}
              />
            </label>
            {supplierMode === 'update' ? (
              <label className="flex min-h-touch items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={supplierActive}
                  disabled={formLocked}
                  onChange={(event) => {
                    flight.current.reset();
                    setSupplierActive(event.target.checked);
                    setValidation(null);
                  }}
                />
                مورد مفعّل للطلبات الجديدة
              </label>
            ) : null}
            <Button type="submit" loading={submission.kind === 'running'} disabled={formLocked}>
              {supplierMode === 'create' ? 'إضافة المورد' : 'حفظ المورد'}
            </Button>
          </form>
        </CardSurface>
      ) : null}

      {workspace === 'suppliers' ? (
        <>
          {!canManage ? (
            <StatusNote tone="info">
              الموردون للقراءة فقط؛ لا تملك صلاحية إضافتهم أو تعديلهم.
            </StatusNote>
          ) : null}
          <SuppliersTable suppliers={pages.suppliers.rows} />
          {pages.suppliers.nextCursor === null ? null : (
            <Button
              type="button"
              variant="outline"
              loading={loadingMore === 'suppliers'}
              disabled={loadingMore !== null || commandLocked}
              onClick={() => onLoadMore('suppliers')}
            >
              تحميل موردين إضافيين
            </Button>
          )}
        </>
      ) : null}

      {workspace === 'orders' && canManage ? (
        <CardSurface className="p-4">
          <form className="flex flex-col gap-4" onSubmit={submitOrder}>
            <div className="grid gap-4 md:grid-cols-3">
              <label className="flex flex-col gap-2 text-sm font-medium">
                المورد
                <select
                  className="h-touch rounded-md border border-input bg-background px-3"
                  value={selectedOrderSupplier?.id ?? ''}
                  disabled={formLocked || activeSuppliers.length === 0}
                  onChange={(event) => {
                    flight.current.reset();
                    setOrderSupplierId(event.target.value);
                    setValidation(null);
                  }}
                >
                  {activeSuppliers.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-2 text-sm font-medium">
                فرع الاستلام
                <select
                  className="h-touch rounded-md border border-input bg-background px-3"
                  value={selectedOrderBranch?.id ?? ''}
                  disabled={formLocked || activeBranches.length === 0}
                  onChange={(event) => {
                    flight.current.reset();
                    setOrderBranchId(event.target.value);
                    setValidation(null);
                  }}
                >
                  {activeBranches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.nameAr} — {isolateLtrText(branch.code)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-2 text-sm font-medium">
                رقم مرجعي (اختياري)
                <input
                  className="h-touch rounded-md border border-input bg-background px-3"
                  maxLength={120}
                  disabled={formLocked}
                  value={orderReference}
                  onChange={(event) => {
                    flight.current.reset();
                    setOrderReference(event.target.value);
                    setValidation(null);
                  }}
                />
              </label>
            </div>
            {activeSuppliers.length === 0 ||
            activeBranches.length === 0 ||
            activeProducts.length === 0 ? (
              <StatusNote tone="warning">
                يلزم مورد وفرع وصنف مفعّل متتبع قبل إنشاء أمر شراء.
              </StatusNote>
            ) : null}
            {orderLines.map((line, index) => {
              const selected = resolveOrderLineProduct(activeProducts, line.productId, index);
              return (
                <div
                  key={line.key}
                  className="grid gap-3 rounded-md border border-border p-3 md:grid-cols-[1fr_1fr_auto]"
                >
                  <label className="flex flex-col gap-2 text-sm font-medium">
                    الصنف
                    <select
                      className="h-touch rounded-md border border-input bg-background px-3"
                      disabled={formLocked || activeProducts.length === 0}
                      value={selected?.id ?? ''}
                      onChange={(event) => {
                        flight.current.reset();
                        setOrderLines((current) =>
                          current.map((item) =>
                            item.key === line.key
                              ? { ...item, productId: event.target.value }
                              : item,
                          ),
                        );
                        setValidation(null);
                      }}
                    >
                      {activeProducts.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.nameAr} — {isolateLtrText(product.sku)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-2 text-sm font-medium">
                    الكمية المطلوبة
                    <input
                      className="h-touch rounded-md border border-input bg-background px-3 font-mono"
                      dir="ltr"
                      inputMode="decimal"
                      disabled={formLocked}
                      value={line.quantity}
                      onChange={(event) => {
                        flight.current.reset();
                        setOrderLines((current) =>
                          current.map((item) =>
                            item.key === line.key
                              ? { ...item, quantity: event.target.value }
                              : item,
                          ),
                        );
                        setValidation(null);
                      }}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`حذف بند أمر الشراء ${String(index + 1)}`}
                    disabled={formLocked || orderLines.length === 1}
                    onClick={() =>
                      setOrderLines((current) => current.filter((item) => item.key !== line.key))
                    }
                  >
                    حذف
                  </Button>
                </div>
              );
            })}
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={
                  formLocked ||
                  orderLines.length >= MAX_PURCHASING_LINES ||
                  activeProducts.length <= orderLines.length
                }
                onClick={() => {
                  const key = `line-${String(nextLine.current++)}`;
                  const used = new Set(
                    orderLines.flatMap((line, index) => {
                      const product = resolveOrderLineProduct(
                        activeProducts,
                        line.productId,
                        index,
                      );
                      return product === undefined ? [] : [product.id];
                    }),
                  );
                  const product = activeProducts.find((candidate) => !used.has(candidate.id));
                  setOrderLines((current) => [
                    ...current,
                    { key, productId: product?.id ?? '', quantity: '' },
                  ]);
                }}
              >
                إضافة بند
              </Button>
              <Button
                type="submit"
                loading={submission.kind === 'running'}
                disabled={
                  formLocked ||
                  activeSuppliers.length === 0 ||
                  activeBranches.length === 0 ||
                  activeProducts.length === 0
                }
              >
                إنشاء أمر الشراء
              </Button>
            </div>
          </form>
        </CardSurface>
      ) : null}

      {workspace === 'orders' && !canManage ? (
        <StatusNote tone="info">لديك صلاحية قراءة المشتريات دون إنشاء أوامر جديدة.</StatusNote>
      ) : null}

      {workspace === 'suppliers' ? null : (
        <>
          <OrdersTable
            pages={pages}
            selectedOrderId={selectedOrderId}
            disabled={commandLocked}
            onSelect={(orderId) => {
              setSelectedOrderId(orderId);
              setReceiptQuantities({});
              setReceiptInventoryValues({});
              setValidation(null);
            }}
          />
          {pages.orders.nextCursor === null ? null : (
            <Button
              type="button"
              variant="outline"
              loading={loadingMore === 'orders'}
              disabled={loadingMore !== null || commandLocked}
              onClick={() => onLoadMore('orders')}
            >
              تحميل أوامر إضافية
            </Button>
          )}
        </>
      )}

      {workspace === 'orders' ? (
        <OrderDetail
          state={detail}
          products={pages.products.rows}
          onRetry={() => void loadDetail()}
        />
      ) : null}

      {workspace === 'receiving' ? (
        <>
          <OrderDetail
            state={detail}
            products={pages.products.rows}
            onRetry={() => void loadDetail()}
          />
          {canReceive && detail.kind === 'ready' && detail.order.status !== 'received' ? (
            <CardSurface className="p-4">
              <form className="flex flex-col gap-4" onSubmit={submitReceipt}>
                <p className="text-sm text-muted-foreground">
                  سجّل الكمية المقبولة فعليًا فقط. يشتق الخادم المتبقي والحالة وأثر المخزون تحت
                  الأقفال.
                </p>
                {canManageCost ? (
                  <StatusNote tone="info">
                    اترك خيار القيمة غير محدد لتسجيل تكلفة مجهولة. عند تحديده، أدخل إجمالي قيمة
                    اقتناء الكمية المقبولة في ذلك السطر؛ القيمة ليست سعر وحدة ولا ضريبة ولا سعر بيع،
                    و0.00 قيمة معروفة صفرية وليست تكلفة مجهولة.
                  </StatusNote>
                ) : (
                  <StatusNote tone="warning">
                    سيُسجل هذا الاستلام بتكلفة مجهولة حتى تُضاف قيمة اقتناء موثوقة بصلاحية التكلفة
                    المستقلة. لا يحوّل النظام التكلفة المجهولة إلى صفر.
                  </StatusNote>
                )}
                <label className="flex flex-col gap-2 text-sm font-medium">
                  مرجع إشعار التسليم (اختياري)
                  <input
                    className="h-touch rounded-md border border-input bg-background px-3"
                    maxLength={120}
                    disabled={formLocked}
                    value={receiptReference}
                    onChange={(event) => {
                      flight.current.reset();
                      setReceiptReference(event.target.value);
                      setValidation(null);
                    }}
                  />
                </label>
                {detail.order.lines
                  .filter((line) => line.remainingQuantityScaled !== '0')
                  .map((line) => {
                    const inventoryValue = receiptInventoryValues[line.id] ?? {
                      enabled: false,
                      value: '',
                    };
                    return (
                      <ReceiptLineEditor
                        key={line.id}
                        line={line}
                        label={productName(pages.products.rows, line.productId)}
                        quantity={receiptQuantities[line.id] ?? ''}
                        inventoryValue={inventoryValue}
                        canManageCost={canManageCost}
                        disabled={formLocked}
                        onQuantityChange={(value) => {
                          flight.current.reset();
                          setReceiptQuantities((current) => ({ ...current, [line.id]: value }));
                          setValidation(null);
                        }}
                        onCostEnabledChange={(enabled) => {
                          flight.current.reset();
                          setReceiptInventoryValues((current) => ({
                            ...current,
                            [line.id]: { enabled, value: current[line.id]?.value ?? '' },
                          }));
                          setValidation(null);
                        }}
                        onCostValueChange={(value) => {
                          flight.current.reset();
                          setReceiptInventoryValues((current) => ({
                            ...current,
                            [line.id]: { enabled: true, value },
                          }));
                          setValidation(null);
                        }}
                      />
                    );
                  })}
                <Button type="submit" loading={submission.kind === 'running'} disabled={formLocked}>
                  تسجيل الاستلام
                </Button>
              </form>
            </CardSurface>
          ) : null}
          {!canReceive ? (
            <StatusNote tone="info">
              الاستلامات للقراءة فقط؛ لا تملك صلاحية تأكيد وصول البضاعة.
            </StatusNote>
          ) : null}
        </>
      ) : null}

      {workspace !== 'orders' || pages.suppliers.nextCursor === null ? null : (
        <Button
          type="button"
          variant="outline"
          loading={loadingMore === 'suppliers'}
          disabled={loadingMore !== null || commandLocked}
          onClick={() => onLoadMore('suppliers')}
        >
          تحميل موردين إضافيين
        </Button>
      )}
      {workspace === 'suppliers' || pages.products.nextCursor === null ? null : (
        <Button
          type="button"
          variant="outline"
          loading={loadingMore === 'products'}
          disabled={loadingMore !== null || commandLocked}
          onClick={() => onLoadMore('products')}
        >
          تحميل أصناف إضافية
        </Button>
      )}
      {workspace !== 'orders' || pages.branches.nextCursor === null ? null : (
        <Button
          type="button"
          variant="outline"
          loading={loadingMore === 'branches'}
          disabled={loadingMore !== null || commandLocked}
          onClick={() => onLoadMore('branches')}
        >
          تحميل فروع إضافية
        </Button>
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
      {submission.kind === 'failed' && submission.failure.action === 'retry-same' ? (
        <Button type="button" onClick={retrySame}>
          إعادة إرسال نفس العملية
        </Button>
      ) : null}
      {submission.kind === 'failed' && submission.failure.action === 'refresh-purchasing' ? (
        <Button type="button" variant="outline" onClick={reconcile}>
          إعادة تحديث سجل المشتريات
        </Button>
      ) : null}
      {submission.kind === 'succeeded' ? (
        <>
          <ResultSummary result={submission.result} />
          <Button type="button" variant="outline" onClick={() => clearDecision()}>
            بدء عملية جديدة
          </Button>
        </>
      ) : null}
    </section>
  );
}
