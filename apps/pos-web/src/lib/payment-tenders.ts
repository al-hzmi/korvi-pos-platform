import { parseSarToMinor } from './money';
import type { CheckoutTenderRequest } from './api-types';
import type { TenderScheme } from '@korvi/domain';

export type PaymentMode = 'cash' | 'mixed';

export interface ElectronicTenderDraft {
  readonly scheme: TenderScheme;
  readonly amount: string;
  readonly reference: string;
}

export interface PaymentPlan {
  readonly valid: boolean;
  readonly message: string | null;
  readonly cashMinor: string;
  readonly electronicMinor: string;
  readonly tenderedMinor: string;
  readonly remainingMinor: string;
  readonly changeMinor: string;
  readonly tenders: readonly CheckoutTenderRequest[];
}

export const MAX_ELECTRONIC_TENDERS = 7;

export function emptyElectronicTender(): ElectronicTenderDraft {
  return { scheme: 'mada', amount: '', reference: '' };
}

function invalid(
  total: bigint,
  cash: bigint,
  electronic: bigint,
  message: string,
): PaymentPlan {
  const tendered = cash + electronic;
  return {
    valid: false,
    message,
    cashMinor: cash.toString(),
    electronicMinor: electronic.toString(),
    tenderedMinor: tendered.toString(),
    remainingMinor: (tendered < total ? total - tendered : 0n).toString(),
    changeMinor: (tendered > total ? tendered - total : 0n).toString(),
    tenders: [],
  };
}

/**
 * Cashier-side payment composition preview.
 *
 * This is UX validation only. The server/domain remains financial authority and
 * independently re-validates every tender, reference and amount. Keeping all
 * arithmetic here in bigint/minor units prevents the split-payment screen from
 * becoming a second money engine based on floating point.
 */
export function planPayment(
  totalMinor: string,
  mode: PaymentMode,
  cashInput: string,
  electronicDrafts: readonly ElectronicTenderDraft[],
): PaymentPlan {
  const total = BigInt(totalMinor);

  if (mode === 'cash') {
    const parsed = parseSarToMinor(cashInput);
    if (!parsed.ok) return invalid(total, 0n, 0n, 'أدخل المبلغ النقدي المستلم.');
    const cash = BigInt(parsed.value);
    if (cash < total) return invalid(total, cash, 0n, 'المبلغ النقدي أقل من المستحق.');
    return {
      valid: true,
      message: null,
      cashMinor: cash.toString(),
      electronicMinor: '0',
      tenderedMinor: cash.toString(),
      remainingMinor: '0',
      changeMinor: (cash - total).toString(),
      tenders: [{ kind: 'cash', amountMinor: cash.toString() }],
    };
  }

  if (electronicDrafts.length === 0) {
    return invalid(total, 0n, 0n, 'أضف دفعة إلكترونية واحدة على الأقل.');
  }
  if (electronicDrafts.length > MAX_ELECTRONIC_TENDERS) {
    return invalid(total, 0n, 0n, 'عدد الدفعات الإلكترونية يتجاوز الحد المسموح.');
  }

  let cash = 0n;
  if (cashInput.trim() !== '') {
    const parsed = parseSarToMinor(cashInput);
    if (!parsed.ok) return invalid(total, 0n, 0n, 'راجع مبلغ النقد.');
    cash = BigInt(parsed.value);
  }

  let electronic = 0n;
  const tenders: CheckoutTenderRequest[] = [];
  const seen = new Set<string>();
  for (const draft of electronicDrafts) {
    const parsed = parseSarToMinor(draft.amount);
    if (!parsed.ok || BigInt(parsed.value) <= 0n) {
      return invalid(total, cash, electronic, 'كل دفعة إلكترونية تحتاج مبلغاً أكبر من صفر.');
    }
    const reference = draft.reference.trim();
    if (reference === '' || reference.length > 64) {
      return invalid(total, cash, electronic, 'أدخل مرجع الموافقة لكل دفعة إلكترونية.');
    }
    const key = `${draft.scheme}:${reference}`;
    if (seen.has(key)) {
      return invalid(total, cash, electronic, 'مرجع الموافقة نفسه لا يمكن احتسابه مرتين.');
    }
    seen.add(key);
    const amount = BigInt(parsed.value);
    electronic += amount;
    tenders.push({
      kind: 'electronic',
      amountMinor: amount.toString(),
      scheme: draft.scheme,
      reference,
    });
  }

  // Electronic instruments cannot return change. The server enforces the same
  // invariant; surfacing it here prevents an avoidable round-trip at the till.
  if (electronic > total) {
    return invalid(total, cash, electronic, 'إجمالي الدفع الإلكتروني يتجاوز المستحق.');
  }

  if (cash > 0n) tenders.push({ kind: 'cash', amountMinor: cash.toString() });
  const tendered = cash + electronic;
  if (tendered < total) {
    return invalid(total, cash, electronic, 'باقي مبلغ لم تتم تغطيته بعد.');
  }

  return {
    valid: true,
    message: null,
    cashMinor: cash.toString(),
    electronicMinor: electronic.toString(),
    tenderedMinor: tendered.toString(),
    remainingMinor: '0',
    changeMinor: (tendered - total).toString(),
    tenders,
  };
}
