import { ApiError } from './api';
import { parseSarToPostgresMinor } from './money';
import type { ApiClient } from './api';
import type { InventoryCostBalanceRow, InventoryCostBootstrapResult } from './api-types';
import type { CostCommandIntent, CostFlightOutcome } from './cost-command-flight';

export type CostCommandFailureAction =
  'reauthenticate' | 'permission' | 'retry-same' | 'refresh-cost' | 'edit-command' | 'blocking';

export interface CostCommandFailure {
  readonly code: string;
  readonly message: string;
  readonly action: CostCommandFailureAction;
}

export type CostCommandDraftResult =
  | { readonly ok: true; readonly intent: CostCommandIntent }
  | { readonly ok: false; readonly message: string };

function valueMessage(reason: string): string {
  if (reason === 'empty') return 'أدخل إجمالي قيمة اقتناء الكمية المجهولة.';
  if (reason === 'precision') return 'قيمة الاقتناء تقبل منزلتين عشريتين كحد أقصى.';
  return 'أدخل قيمة اقتناء صحيحة بالريال دون فواصل أو رموز.';
}

/** Build one decision bound to the exact row the manager reviewed. */
export function buildCostBootstrapIntent(
  draft: {
    readonly branchId: string;
    readonly product: InventoryCostBalanceRow;
    readonly totalValue: string;
  },
  mint: () => string,
): CostCommandDraftResult {
  if (!draft.product.isActive || !draft.product.trackInventory) {
    return { ok: false, message: 'الصنف لم يعد مفعّلًا أو متتبعًا للمخزون.' };
  }
  if (!/^[1-9][0-9]*$/.test(draft.product.unknownPositiveQuantityScaled)) {
    return { ok: false, message: 'لا توجد كمية موجبة مجهولة التكلفة لتقييمها.' };
  }
  const value = parseSarToPostgresMinor(draft.totalValue);
  if (!value.ok) return { ok: false, message: valueMessage(value.reason) };

  return {
    ok: true,
    intent: {
      kind: 'bootstrap',
      request: {
        operationId: mint(),
        branchId: draft.branchId,
        productId: draft.product.productId,
        totalValueMinor: value.value,
        expectedStockRevision: draft.product.stockRevision,
        expectedCostRevision: draft.product.costRevision,
        expectedUnknownPositiveQuantityScaled: draft.product.unknownPositiveQuantityScaled,
      },
    },
  };
}

const FALLBACK = 'تعذّر إتمام تقييم تكلفة المخزون. راجع البيانات وحاول مرة أخرى.';

export function describeCostCommandFailure(error: unknown): CostCommandFailure {
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
      message: 'لا تملك صلاحية إدارة تقييم تكلفة المخزون.',
      action: 'permission',
    };
  }
  if (error.status === 0 || error.status >= 500) {
    return {
      code: error.code,
      message:
        error.code === 'timeout'
          ? 'لم يصل ردّ الخادم. قد يكون التقييم سُجل؛ أعد إرسال نفس العملية فقط.'
          : 'تعذر تأكيد نتيجة التقييم. أعد إرسال نفس العملية فقط عند عودة الاتصال.',
      action: 'retry-same',
    };
  }
  if (error.code === 'idempotency_conflict') {
    return {
      code: error.code,
      message: error.serverMessage ?? 'رقم العملية مرتبط بتقييم مختلف. أوقف المحاولة وراجع السجل.',
      action: 'blocking',
    };
  }
  if (
    error.status === 404 ||
    [
      'nothing_to_value',
      'inactive_branch',
      'inactive_product',
      'untracked_product',
      'stock_changed',
      'cost_state_changed',
    ].includes(error.code)
  ) {
    return {
      code: error.code,
      message:
        error.serverMessage ?? 'تغيّرت حالة التكلفة أو المخزون. حدّث البيانات ثم أعد القرار.',
      action: 'refresh-cost',
    };
  }
  return { code: error.code, message: error.serverMessage ?? FALLBACK, action: 'edit-command' };
}

export function costFlightOutcomeFor(action: CostCommandFailureAction): CostFlightOutcome {
  if (action === 'retry-same') return 'ambiguous';
  if (action === 'blocking' || action === 'permission' || action === 'reauthenticate') {
    return 'blocked';
  }
  return 'amendable';
}

export async function executeCostCommand(
  api: ApiClient,
  intent: CostCommandIntent,
): Promise<InventoryCostBootstrapResult> {
  return api.inventoryCostBootstrap(intent.request);
}
