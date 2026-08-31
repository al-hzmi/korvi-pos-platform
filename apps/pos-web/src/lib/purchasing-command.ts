import { MAX_PURCHASING_LINES, MAX_PURCHASING_REFERENCE, MAX_SUPPLIER_NAME } from '@korvi/domain';
import { ApiError } from './api';
import { parseSarToPostgresMinor } from './money';
import { parseInventoryQuantityToScaled } from './quantity';
import type { ApiClient } from './api';
import type {
  PurchaseOrder,
  PurchaseOrderCreateResult,
  PurchaseReceiptResult,
  PurchasingProduct,
  SupplierMutationResult,
} from './api-types';
import type { PurchasingCommandIntent, PurchasingFlightOutcome } from './purchasing-command-flight';

export type PurchasingCommandFailureAction =
  | 'reauthenticate'
  | 'permission'
  | 'retry-same'
  | 'refresh-purchasing'
  | 'edit-command'
  | 'blocking';

export interface PurchasingCommandFailure {
  readonly code: string;
  readonly message: string;
  readonly action: PurchasingCommandFailureAction;
}

export type PurchasingDraftResult =
  | { readonly ok: true; readonly intent: PurchasingCommandIntent }
  | { readonly ok: false; readonly message: string };

export interface ReceiptInventoryValueDraft {
  /** Explicit opt-in keeps omitted unknown cost distinct from known zero. */
  readonly enabled: boolean;
  readonly value: string;
}

function boundedOptionalReference(reference: string): string | null | undefined {
  const trimmed = reference.trim();
  if (trimmed.length > MAX_PURCHASING_REFERENCE) return undefined;
  return trimmed === '' ? null : trimmed;
}

function quantityMessage(reason: string): string {
  if (reason === 'empty') return 'أدخل الكمية.';
  if (reason === 'precision') {
    return 'كمية الصنف العددي يجب أن تكون عددًا صحيحًا، والوزني يقبل حتى ثلاث منازل.';
  }
  if (reason === 'not-positive' || reason === 'zero') {
    return 'كمية الشراء أو الاستلام يجب أن تكون أكبر من صفر.';
  }
  return 'أدخل كمية عشرية صحيحة دون فواصل أو رموز.';
}

function inventoryValueMessage(reason: string): string {
  if (reason === 'empty') {
    return 'أدخل إجمالي قيمة اقتناء الكمية المستلمة أو ألغِ خيار تسجيل القيمة.';
  }
  if (reason === 'precision') return 'قيمة الاقتناء تقبل منزلتين عشريتين كحد أقصى.';
  return 'أدخل قيمة اقتناء صحيحة بالريال دون فواصل أو رموز.';
}

export function buildSupplierCreateIntent(name: string, mint: () => string): PurchasingDraftResult {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > MAX_SUPPLIER_NAME) {
    return { ok: false, message: `اسم المورد مطلوب وبحد أقصى ${String(MAX_SUPPLIER_NAME)} حرفًا.` };
  }
  return {
    ok: true,
    intent: { kind: 'supplier-create', request: { operationId: mint(), name: trimmed } },
  };
}

export function buildSupplierUpdateIntent(
  input: {
    readonly supplierId: string;
    readonly name: string;
    readonly originalName: string;
    readonly isActive: boolean;
    readonly originalIsActive: boolean;
  },
  mint: () => string,
): PurchasingDraftResult {
  const name = input.name.trim();
  if (name === '' || name.length > MAX_SUPPLIER_NAME) {
    return { ok: false, message: `اسم المورد مطلوب وبحد أقصى ${String(MAX_SUPPLIER_NAME)} حرفًا.` };
  }
  const nameChanged = name !== input.originalName;
  const activeChanged = input.isActive !== input.originalIsActive;
  if (!nameChanged && !activeChanged) {
    return { ok: false, message: 'لم يتغير اسم المورد أو حالته.' };
  }
  return {
    ok: true,
    intent: {
      kind: 'supplier-update',
      request: {
        operationId: mint(),
        supplierId: input.supplierId,
        ...(nameChanged ? { name } : {}),
        ...(activeChanged ? { isActive: input.isActive } : {}),
      },
    },
  };
}

export function buildPurchaseOrderIntent(
  input: {
    readonly supplierId: string;
    readonly branchId: string;
    readonly reference: string;
    readonly lines: readonly { readonly product: PurchasingProduct; readonly quantity: string }[];
  },
  mint: () => string,
): PurchasingDraftResult {
  if (input.supplierId === '') return { ok: false, message: 'اختر موردًا مفعّلًا.' };
  if (input.branchId === '') return { ok: false, message: 'اختر فرع استلام مفعّلًا.' };
  if (input.lines.length === 0) return { ok: false, message: 'أضف بند شراء واحدًا على الأقل.' };
  if (input.lines.length > MAX_PURCHASING_LINES) {
    return { ok: false, message: 'عدد بنود أمر الشراء تجاوز الحد المسموح.' };
  }
  const ids = input.lines.map((line) => line.product.id);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, message: 'لا يمكن تكرار الصنف نفسه في أمر الشراء.' };
  }
  const reference = boundedOptionalReference(input.reference);
  if (reference === undefined) {
    return { ok: false, message: 'الرقم المرجعي تجاوز 120 حرفًا.' };
  }

  const lines: { productId: string; orderedQuantityScaled: string }[] = [];
  for (const line of input.lines) {
    if (!line.product.isActive || !line.product.trackInventory) {
      return { ok: false, message: 'أحد الأصناف لم يعد مفعّلًا أو متتبعًا للمخزون.' };
    }
    const quantity = parseInventoryQuantityToScaled(line.quantity, line.product.productType);
    if (!quantity.ok) return { ok: false, message: quantityMessage(quantity.reason) };
    lines.push({ productId: line.product.id, orderedQuantityScaled: quantity.value });
  }

  return {
    ok: true,
    intent: {
      kind: 'order-create',
      request: {
        operationId: mint(),
        supplierId: input.supplierId,
        branchId: input.branchId,
        reference,
        lines,
      },
    },
  };
}

export function buildPurchaseReceiptIntent(
  input: {
    readonly order: PurchaseOrder;
    readonly reference: string;
    readonly products: readonly PurchasingProduct[];
    readonly quantities: Readonly<Record<string, string>>;
    readonly inventoryValues?: Readonly<Record<string, ReceiptInventoryValueDraft>>;
  },
  mint: () => string,
): PurchasingDraftResult {
  if (input.order.status === 'received') {
    return { ok: false, message: 'تم استلام أمر الشراء بالكامل.' };
  }
  const reference = boundedOptionalReference(input.reference);
  if (reference === undefined) {
    return { ok: false, message: 'الرقم المرجعي تجاوز 120 حرفًا.' };
  }

  const lines: {
    purchaseOrderLineId: string;
    acceptedQuantityScaled: string;
    inventoryValueMinor?: string;
  }[] = [];
  for (const line of input.order.lines) {
    const draft = input.quantities[line.id]?.trim() ?? '';
    const valueDraft = input.inventoryValues?.[line.id];
    if (draft === '') {
      if (valueDraft?.enabled === true) {
        return { ok: false, message: 'أدخل كمية الاستلام قبل تسجيل قيمة اقتنائها.' };
      }
      continue;
    }
    const product = input.products.find((candidate) => candidate.id === line.productId);
    if (product === undefined) {
      return { ok: false, message: 'تعذر إثبات نوع أحد أصناف الأمر. حدّث بيانات المشتريات.' };
    }
    const quantity = parseInventoryQuantityToScaled(draft, product.productType);
    if (!quantity.ok) return { ok: false, message: quantityMessage(quantity.reason) };
    if (BigInt(quantity.value) > BigInt(line.remainingQuantityScaled)) {
      return { ok: false, message: 'إحدى كميات الاستلام تتجاوز الكمية المتبقية في الأمر.' };
    }
    if (valueDraft?.enabled === true) {
      const value = parseSarToPostgresMinor(valueDraft.value);
      if (!value.ok) return { ok: false, message: inventoryValueMessage(value.reason) };
      lines.push({
        purchaseOrderLineId: line.id,
        acceptedQuantityScaled: quantity.value,
        inventoryValueMinor: value.value,
      });
    } else {
      lines.push({ purchaseOrderLineId: line.id, acceptedQuantityScaled: quantity.value });
    }
  }
  if (lines.length === 0) {
    return { ok: false, message: 'أدخل كمية مستلمة لبند واحد على الأقل.' };
  }

  return {
    ok: true,
    intent: {
      kind: 'receipt',
      request: {
        operationId: mint(),
        purchaseOrderId: input.order.id,
        reference,
        // A line without inventoryValueMinor remains explicit unknown cost;
        // present "0" remains known zero and is never collapsed by truthiness.
        lines,
      },
    },
  };
}

const FALLBACK = 'تعذّر إتمام عملية المشتريات. راجع البيانات وحاول مرة أخرى.';

export function describePurchasingCommandFailure(error: unknown): PurchasingCommandFailure {
  if (!(error instanceof ApiError)) {
    return { code: 'unexpected', message: FALLBACK, action: 'blocking' };
  }
  if (error.unauthenticated) {
    return {
      code: error.code,
      message: 'انتهت الجلسة. سجّل الدخول من جديد.',
      action: 'reauthenticate',
    };
  }
  if (error.forbidden) {
    return {
      code: error.code,
      message: 'لا تملك صلاحية تنفيذ عملية المشتريات هذه.',
      action: 'permission',
    };
  }
  if (error.status === 0 || error.status >= 500) {
    return {
      code: error.code,
      message:
        error.code === 'timeout'
          ? 'لم يصل ردّ الخادم. قد تكون العملية سُجلت؛ أعد إرسال الطلب نفسه فقط.'
          : 'تعذر تأكيد النتيجة. أعد إرسال الطلب نفسه فقط عند عودة الاتصال.',
      action: 'retry-same',
    };
  }
  if (error.code === 'idempotency_conflict') {
    return {
      code: error.code,
      message: error.serverMessage ?? 'رقم العملية مرتبط بطلب مختلف. أوقف المحاولة وراجع السجل.',
      action: 'blocking',
    };
  }
  if (
    error.status === 404 ||
    [
      'inactive_supplier',
      'inactive_branch',
      'inactive_product',
      'untracked_product',
      'purchase_order_closed',
      'over_receipt',
    ].includes(error.code)
  ) {
    return {
      code: error.code,
      message: error.serverMessage ?? 'تغيّرت بيانات المشتريات. حدّث السجل ثم أعد الإدخال.',
      action: 'refresh-purchasing',
    };
  }
  return { code: error.code, message: error.serverMessage ?? FALLBACK, action: 'edit-command' };
}

export function purchasingFlightOutcomeFor(
  action: PurchasingCommandFailureAction,
): PurchasingFlightOutcome {
  if (action === 'retry-same') return 'ambiguous';
  if (action === 'blocking' || action === 'permission' || action === 'reauthenticate') {
    return 'blocked';
  }
  return 'amendable';
}

export type PurchasingCommandResult =
  | { readonly kind: 'supplier-create'; readonly value: SupplierMutationResult }
  | { readonly kind: 'supplier-update'; readonly value: SupplierMutationResult }
  | { readonly kind: 'order-create'; readonly value: PurchaseOrderCreateResult }
  | { readonly kind: 'receipt'; readonly value: PurchaseReceiptResult };

export async function executePurchasingCommand(
  api: ApiClient,
  intent: PurchasingCommandIntent,
): Promise<PurchasingCommandResult> {
  switch (intent.kind) {
    case 'supplier-create':
      return { kind: intent.kind, value: await api.createPurchasingSupplier(intent.request) };
    case 'supplier-update':
      return { kind: intent.kind, value: await api.updatePurchasingSupplier(intent.request) };
    case 'order-create':
      return { kind: intent.kind, value: await api.createPurchaseOrder(intent.request) };
    case 'receipt':
      return { kind: intent.kind, value: await api.receivePurchaseOrder(intent.request) };
  }
}
