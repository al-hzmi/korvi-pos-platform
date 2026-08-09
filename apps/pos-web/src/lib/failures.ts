import { ApiError } from './api';

/**
 * Server outcomes, translated into something a person at a till can act on.
 *
 * The server already sends Arabic for the checkout reasons, and where it does
 * that text is used verbatim — it is written for this screen. The map here
 * exists for the codes it does not phrase, and to attach the one thing a
 * message cannot carry: what the interface should do next.
 *
 * Nothing from the transport is ever shown. A cashier who sees a Prisma error
 * cannot act on it, and an attacker who sees one learns the schema.
 */

export type FailureAction =
  /** The session is gone; go back to login. */
  | 'reauthenticate'
  /** The role does not permit this. */
  | 'permission'
  /** Re-read the shift before trying again. */
  | 'refresh-shift'
  /** Open a shift first. */
  | 'open-shift'
  /** The basket is still valid; fix it and retry. */
  | 'amend-cart'
  /** Put the focus back in the cash field. */
  | 'amend-cash'
  /** Ambiguous: the same request may safely be sent again, unchanged. */
  | 'retry-same'
  /** Stop. A human has to decide. */
  | 'blocking'
  /** Nothing specific; show and carry on. */
  | 'notice';

export interface Failure {
  readonly code: string;
  readonly message: string;
  readonly action: FailureAction;
}

const FALLBACK = 'تعذّر إتمام العملية. حاول مرة أخرى.';

const KNOWN: Readonly<Record<string, { message: string; action: FailureAction }>> = {
  network: {
    message: 'تعذّر الوصول إلى الخادم. السلة محفوظة، ويمكن إعادة المحاولة بأمان.',
    action: 'retry-same',
  },
  timeout: {
    // Not "it failed": nobody knows whether it failed. Retrying the same
    // operation id is the safe move and the only one offered.
    message:
      'لم يصل ردّ الخادم في الوقت المتوقع. قد تكون العملية قد تمّت — أعد الإرسال بنفس العملية للتأكد.',
    action: 'retry-same',
  },
  unauthenticated: { message: 'انتهت الجلسة. سجّل الدخول من جديد.', action: 'reauthenticate' },
  forbidden: { message: 'لا تملك صلاحية تنفيذ هذه العملية.', action: 'permission' },
  invalid_credentials: { message: 'بيانات الدخول غير صحيحة.', action: 'notice' },
  unavailable: { message: 'الخدمة غير متاحة حالياً. حاول بعد قليل.', action: 'retry-same' },
  branch_required: {
    message: 'لا يوجد فرع مرتبط بهذا المستخدم. راجع إعدادات المنشأة.',
    action: 'blocking',
  },
  unknown_terminal: { message: 'الصندوق غير معروف أو غير مفعّل.', action: 'blocking' },
  shift_already_open: { message: 'توجد وردية مفتوحة على هذا الصندوق.', action: 'refresh-shift' },
  'no-open-shift': {
    message: 'لا توجد وردية مفتوحة على هذا الصندوق. افتح وردية أولاً.',
    action: 'open-shift',
  },
  'shift-invalid': {
    message: 'الوردية لم تعد صالحة لهذا الصندوق. سيتم تحديث حالة الوردية.',
    action: 'refresh-shift',
  },
  'insufficient-stock': {
    message: 'الكمية المطلوبة لم تعد متوفرة. السلة كما هي — عدّل الكمية وأعد المحاولة.',
    action: 'amend-cart',
  },
  'unknown-product': {
    message: 'أحد الأصناف لم يعد موجوداً. احذفه من السلة.',
    action: 'amend-cart',
  },
  'product-unavailable': {
    message: 'أحد الأصناف لم يعد متاحاً للبيع. احذفه من السلة.',
    action: 'amend-cart',
  },
  'invalid-quantity': { message: 'الكمية غير صالحة لهذا الصنف.', action: 'amend-cart' },
  'duplicate-line': {
    message: 'الصنف مكرر في السلة. ادمج الكمية في سطر واحد.',
    action: 'amend-cart',
  },
  'empty-cart': { message: 'لا توجد أصناف في السلة.', action: 'amend-cart' },
  'insufficient-cash': { message: 'المبلغ المستلم أقل من المطلوب.', action: 'amend-cash' },
  'idempotency-conflict': {
    message:
      'هناك عملية سابقة بنفس المعرّف ومحتوى مختلف. لا تُعاد المحاولة تلقائياً — راجع آخر فاتورة قبل المتابعة.',
    action: 'blocking',
  },
  'tenant-misconfigured': { message: 'إعدادات المنشأة غير مكتملة.', action: 'blocking' },
};

export function describeFailure(error: unknown): Failure {
  if (!(error instanceof ApiError)) {
    return { code: 'unexpected', message: FALLBACK, action: 'notice' };
  }

  const known = KNOWN[error.code];
  if (known !== undefined) {
    // The server's own wording wins where it sent one: it was written for a
    // cashier, and it is closer to what actually happened than a code map.
    return {
      code: error.code,
      message: error.serverMessage ?? known.message,
      action: known.action,
    };
  }

  if (error.unauthenticated) {
    return {
      code: error.code,
      message: KNOWN['unauthenticated']!.message,
      action: 'reauthenticate',
    };
  }
  if (error.forbidden) {
    return { code: error.code, message: KNOWN['forbidden']!.message, action: 'permission' };
  }
  if (error.status >= 500) {
    return { code: error.code, message: KNOWN['unavailable']!.message, action: 'retry-same' };
  }
  return { code: error.code, message: error.serverMessage ?? FALLBACK, action: 'notice' };
}
