import { ApiError } from './api';
import {
  parseAdjustmentQuantityToScaled,
  parseCountedQuantityToScaled,
  parseInventoryQuantityToScaled,
} from './quantity';
import type { ApiClient } from './api';
import type {
  InventoryAdjustmentResult,
  InventoryCountResult,
  InventoryTransferResult,
} from './api-types';
import type { InventoryBalanceRow } from './api-types';
import type { InventoryCommandIntent, InventoryFlightOutcome } from './inventory-command-flight';

export type InventoryCommandFailureAction =
  'reauthenticate' | 'permission' | 'retry-same' | 'refresh-stock' | 'edit-command' | 'blocking';

export interface InventoryCommandFailure {
  readonly code: string;
  readonly message: string;
  readonly action: InventoryCommandFailureAction;
}

export interface InventoryCommandDraft {
  readonly kind: InventoryCommandIntent['kind'];
  readonly branchId: string;
  readonly destinationBranchId: string | null;
  readonly product: InventoryBalanceRow;
  readonly quantity: string;
  readonly reason: string;
}

export type InventoryDraftResult =
  | { readonly ok: true; readonly intent: InventoryCommandIntent }
  | { readonly ok: false; readonly message: string };

function quantityMessage(reason: string, kind: InventoryCommandIntent['kind']): string {
  if (reason === 'empty') return 'أدخل الكمية.';
  if (reason === 'precision') {
    return 'كمية الصنف العددي يجب أن تكون عددًا صحيحًا، والوزني يقبل حتى ثلاث منازل.';
  }
  if (reason === 'zero') return 'كمية التسوية لا يمكن أن تكون صفرًا.';
  if (reason === 'not-positive' && kind === 'transfer') {
    return 'كمية التحويل يجب أن تكون أكبر من صفر.';
  }
  return 'أدخل كمية عشرية صحيحة دون فواصل أو رموز.';
}

/** Converts a human decimal draft into the exact, minimal server intent. */
export function buildInventoryCommandIntent(
  draft: InventoryCommandDraft,
  mint: () => string,
): InventoryDraftResult {
  const trimmedReason = draft.reason.trim();
  if (trimmedReason.length > 200) {
    return { ok: false, message: 'سبب الحركة تجاوز 200 حرف.' };
  }

  if (draft.kind === 'adjustment') {
    if (trimmedReason.length === 0) {
      return { ok: false, message: 'سبب التسوية مطلوب ولا يجوز تركه فارغًا.' };
    }
    const quantity = parseAdjustmentQuantityToScaled(draft.quantity, draft.product.productType);
    if (!quantity.ok) return { ok: false, message: quantityMessage(quantity.reason, draft.kind) };
    return {
      ok: true,
      intent: {
        kind: draft.kind,
        request: {
          operationId: mint(),
          branchId: draft.branchId,
          reason: trimmedReason,
          lines: [{ productId: draft.product.productId, deltaQuantityScaled: quantity.value }],
        },
      },
    };
  }

  if (draft.kind === 'count') {
    const quantity = parseCountedQuantityToScaled(draft.quantity, draft.product.productType);
    if (!quantity.ok) return { ok: false, message: quantityMessage(quantity.reason, draft.kind) };
    return {
      ok: true,
      intent: {
        kind: draft.kind,
        request: {
          operationId: mint(),
          branchId: draft.branchId,
          reason: trimmedReason === '' ? null : trimmedReason,
          lines: [
            {
              productId: draft.product.productId,
              countedQuantityScaled: quantity.value,
              expectedRevision: draft.product.revision,
            },
          ],
        },
      },
    };
  }

  if (draft.destinationBranchId === null || draft.destinationBranchId === draft.branchId) {
    return { ok: false, message: 'اختر فرع وجهة مختلفًا عن فرع المصدر.' };
  }
  const quantity = parseInventoryQuantityToScaled(draft.quantity, draft.product.productType);
  if (!quantity.ok) return { ok: false, message: quantityMessage(quantity.reason, draft.kind) };
  return {
    ok: true,
    intent: {
      kind: draft.kind,
      request: {
        operationId: mint(),
        fromBranchId: draft.branchId,
        toBranchId: draft.destinationBranchId,
        reason: trimmedReason === '' ? null : trimmedReason,
        lines: [{ productId: draft.product.productId, quantityScaled: quantity.value }],
      },
    },
  };
}

const FALLBACK = 'تعذّر إتمام حركة المخزون. راجع البيانات وحاول مرة أخرى.';

export function describeInventoryCommandFailure(error: unknown): InventoryCommandFailure {
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
      message: 'لا تملك صلاحية تنفيذ حركة المخزون هذه.',
      action: 'permission',
    };
  }
  if (error.status === 0 || error.status >= 500) {
    return {
      code: error.code,
      message:
        error.code === 'timeout'
          ? 'لم يصل ردّ الخادم. قد تكون الحركة سُجلت؛ أعد الإرسال بنفس العملية فقط.'
          : 'تعذر تأكيد نتيجة الحركة. أعد الإرسال بنفس العملية فقط عند عودة الاتصال.',
      action: 'retry-same',
    };
  }
  if (error.code === 'idempotency_conflict') {
    return {
      code: error.code,
      message:
        error.serverMessage ??
        'رقم العملية مرتبط بطلب مختلف. أوقف المحاولة وراجع سجل المخزون قبل المتابعة.',
      action: 'blocking',
    };
  }
  if (
    error.code === 'stock_changed' ||
    error.code === 'insufficient_stock' ||
    error.code === 'inactive_branch' ||
    error.code === 'inactive_product' ||
    error.code === 'untracked_product' ||
    error.status === 404
  ) {
    return {
      code: error.code,
      message: error.serverMessage ?? 'تغيرت بيانات المخزون. حدّث الأرصدة ثم أعد إدخال الحركة.',
      action: 'refresh-stock',
    };
  }
  return {
    code: error.code,
    message: error.serverMessage ?? FALLBACK,
    action: 'edit-command',
  };
}

export function inventoryFlightOutcomeFor(
  action: InventoryCommandFailureAction,
): InventoryFlightOutcome {
  if (action === 'retry-same') return 'ambiguous';
  if (action === 'blocking' || action === 'permission' || action === 'reauthenticate') {
    return 'blocked';
  }
  return 'amendable';
}

export type InventoryCommandResult =
  | { readonly kind: 'adjustment'; readonly value: InventoryAdjustmentResult }
  | { readonly kind: 'count'; readonly value: InventoryCountResult }
  | { readonly kind: 'transfer'; readonly value: InventoryTransferResult };

export async function executeInventoryCommand(
  api: ApiClient,
  intent: InventoryCommandIntent,
): Promise<InventoryCommandResult> {
  switch (intent.kind) {
    case 'adjustment':
      return { kind: intent.kind, value: await api.inventoryAdjust(intent.request) };
    case 'count':
      return { kind: intent.kind, value: await api.inventoryCount(intent.request) };
    case 'transfer':
      return { kind: intent.kind, value: await api.inventoryTransfer(intent.request) };
  }
}
