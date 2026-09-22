'use client';

import { Button, Numeric } from '@korvi/ui';
import { Field } from './field';
import { StatusNote } from './status-note';
import { formatMinor } from '../lib/money';
import {
  MAX_ELECTRONIC_TENDERS,
  planPayment,
  type ElectronicTenderDraft,
  type PaymentMode,
} from '../lib/payment-tenders';
import type { JSX, Ref } from 'react';

const SCHEMES = [
  ['mada', 'مدى'],
  ['visa', 'Visa'],
  ['mastercard', 'Mastercard'],
  ['amex', 'Amex'],
  ['apple-pay', 'Apple Pay'],
  ['other', 'أخرى'],
] as const;

/**
 * Cashier payment composition.
 *
 * The panel only prepares intent. Server/domain settlement remains the financial
 * authority and independently validates tender composition, amounts and change.
 */
export interface CheckoutPanelProps {
  readonly totalMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly cash: string;
  readonly paymentMode: PaymentMode;
  readonly electronicTenders: readonly ElectronicTenderDraft[];
  readonly lineCount: number;
  readonly locked: boolean;
  readonly submissionBlocker?: string | null;
  readonly state: import('../lib/checkout').CheckoutState;
  readonly cashRef: Ref<HTMLInputElement>;
  readonly onCashChange: (value: string) => void;
  readonly onPaymentModeChange: (mode: PaymentMode) => void;
  readonly onElectronicTenderChange: (index: number, value: ElectronicTenderDraft) => void;
  readonly onAddElectronicTender: () => void;
  readonly onRemoveElectronicTender: (index: number) => void;
  readonly onSubmit: () => void;
  readonly onDismiss: () => void;
}

export function CheckoutPanel({
  totalMinor,
  netMinor,
  vatMinor,
  cash,
  paymentMode,
  electronicTenders,
  lineCount,
  locked,
  submissionBlocker,
  state,
  cashRef,
  onCashChange,
  onPaymentModeChange,
  onElectronicTenderChange,
  onAddElectronicTender,
  onRemoveElectronicTender,
  onSubmit,
  onDismiss,
}: CheckoutPanelProps): JSX.Element {
  const payment = planPayment(totalMinor, paymentMode, cash, electronicTenders);
  const submitting = state.phase === 'submitting';
  const blocked = state.failure?.action === 'blocking';
  const canSubmit =
    lineCount > 0 &&
    payment.valid &&
    !blocked &&
    (submissionBlocker === null || submissionBlocker === undefined);
  const paymentFrozen = locked;

  return (
    <div className="flex shrink-0 flex-col gap-3 border-t border-border pt-4">
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 shadow-sm">
        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex items-center justify-between text-muted-foreground">
            <dt>الإجمالي قبل الضريبة</dt>
            <dd className="flex items-baseline gap-1">
              <Numeric value={formatMinor(netMinor)} />
              <span className="text-[10px]">ر.س</span>
            </dd>
          </div>
          <div className="flex items-center justify-between text-muted-foreground">
            <dt>ضريبة القيمة المضافة</dt>
            <dd className="flex items-baseline gap-1">
              <Numeric value={formatMinor(vatMinor)} />
              <span className="text-[10px]">ر.س</span>
            </dd>
          </div>
          <div className="mt-1 flex items-end justify-between border-t border-primary/15 pt-3">
            <dt className="text-base font-semibold text-foreground">الإجمالي المستحق</dt>
            <dd className="flex items-baseline gap-1 text-primary">
              <Numeric
                value={formatMinor(totalMinor)}
                className="text-4xl font-bold tracking-tight"
              />
              <span className="text-xs font-semibold">ر.س</span>
            </dd>
          </div>
        </dl>
      </div>

      <div className="rounded-lg border border-border bg-background p-3">
        <div className="mb-3 grid grid-cols-2 gap-2" role="group" aria-label="طريقة الدفع">
          <Button
            type="button"
            variant={paymentMode === 'cash' ? 'secondary' : 'outline'}
            disabled={paymentFrozen}
            onClick={() => onPaymentModeChange('cash')}
          >
            نقدي
          </Button>
          <Button
            type="button"
            variant={paymentMode === 'mixed' ? 'secondary' : 'outline'}
            disabled={paymentFrozen}
            onClick={() => onPaymentModeChange('mixed')}
          >
            إلكتروني / متعدد
          </Button>
        </div>

        <Field
          id="cash-received"
          label={paymentMode === 'cash' ? 'النقد المستلم (ريال)' : 'الجزء النقدي — اختياري (ريال)'}
          inputMode="decimal"
          autoComplete="off"
          dir="ltr"
          disabled={paymentFrozen}
          invalid={cash.trim() !== '' && payment.cashMinor === '0' && cash.trim() !== '0'}
          value={cash}
          inputRef={cashRef}
          className="h-touch-lg text-xl font-semibold"
          onChange={(event) => {
            onCashChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canSubmit && !submitting && !paymentFrozen) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />

        {paymentMode === 'mixed' ? (
          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-muted-foreground">الدفعات الإلكترونية</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={paymentFrozen || electronicTenders.length >= MAX_ELECTRONIC_TENDERS}
                onClick={onAddElectronicTender}
              >
                إضافة دفعة
              </Button>
            </div>

            {electronicTenders.map((tender, index) => (
              <div
                key={index}
                className="grid grid-cols-[minmax(5.5rem,0.7fr)_minmax(5rem,0.7fr)_minmax(7rem,1fr)_auto] gap-2 rounded-md border border-border p-2"
              >
                <select
                  aria-label={`شبكة الدفع ${String(index + 1)}`}
                  value={tender.scheme}
                  disabled={paymentFrozen}
                  onChange={(event) => {
                    onElectronicTenderChange(index, {
                      ...tender,
                      scheme: event.target.value as ElectronicTenderDraft['scheme'],
                    });
                  }}
                  className="h-touch min-w-0 rounded-md border border-input bg-background px-2 text-sm"
                >
                  {SCHEMES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`مبلغ الدفعة الإلكترونية ${String(index + 1)}`}
                  inputMode="decimal"
                  dir="ltr"
                  value={tender.amount}
                  disabled={paymentFrozen}
                  placeholder="0.00"
                  onChange={(event) => {
                    onElectronicTenderChange(index, { ...tender, amount: event.target.value });
                  }}
                  className="h-touch min-w-0 rounded-md border border-input bg-background px-2 text-sm"
                />
                <input
                  aria-label={`مرجع الموافقة ${String(index + 1)}`}
                  dir="ltr"
                  value={tender.reference}
                  maxLength={64}
                  disabled={paymentFrozen}
                  placeholder="مرجع الموافقة"
                  onChange={(event) => {
                    onElectronicTenderChange(index, { ...tender, reference: event.target.value });
                  }}
                  className="h-touch min-w-0 rounded-md border border-input bg-background px-2 text-sm"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={paymentFrozen || electronicTenders.length <= 1}
                  onClick={() => onRemoveElectronicTender(index)}
                  aria-label={`حذف الدفعة الإلكترونية ${String(index + 1)}`}
                >
                  حذف
                </Button>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              أدخل مرجع الموافقة فقط. لا تدخل رقم البطاقة أو CVV أو بيانات حامل البطاقة.
            </p>
          </div>
        ) : null}

        <dl className="mt-3 space-y-2 rounded-md bg-muted px-3 py-2.5 text-sm">
          {paymentMode === 'mixed' ? (
            <>
              <div className="flex items-center justify-between">
                <dt className="font-medium text-muted-foreground">إجمالي المدفوع</dt>
                <dd className="flex items-baseline gap-1">
                  <Numeric value={formatMinor(payment.tenderedMinor)} className="font-bold" />
                  <span className="text-[10px] text-muted-foreground">ر.س</span>
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="font-medium text-muted-foreground">المتبقي</dt>
                <dd className="flex items-baseline gap-1">
                  <Numeric value={formatMinor(payment.remainingMinor)} className="font-bold" />
                  <span className="text-[10px] text-muted-foreground">ر.س</span>
                </dd>
              </div>
            </>
          ) : null}
          <div className="flex items-center justify-between">
            <dt className="font-medium text-muted-foreground">الباقي للعميل</dt>
            <dd className="flex items-baseline gap-1">
              <Numeric value={formatMinor(payment.changeMinor)} className="text-xl font-bold" />
              <span className="text-[10px] text-muted-foreground">ر.س</span>
            </dd>
          </div>
        </dl>

        {payment.message === null ? null : (
          <p className="mt-2 text-xs text-muted-foreground">{payment.message}</p>
        )}
      </div>

      {submissionBlocker === null || submissionBlocker === undefined ? null : (
        <StatusNote tone="warning">{submissionBlocker}</StatusNote>
      )}

      {state.failure === null ? null : (
        <StatusNote tone={state.failure.action === 'blocking' ? 'danger' : 'warning'} live>
          {state.failure.message}
        </StatusNote>
      )}

      {state.attemptOutstanding ? (
        <StatusNote tone="warning">
          لم تصل نتيجة العملية. السلة والدفع مقفلان كما هما — أعد الإرسال بنفس العملية، ولا تُنشئ
          عملية جديدة.
        </StatusNote>
      ) : null}

      <div className="flex gap-2">
        <Button
          size="lg"
          className="h-touch-lg flex-1 text-base font-semibold shadow-sm"
          loading={submitting}
          disabled={!canSubmit}
          onClick={onSubmit}
        >
          {submitting
            ? 'جارٍ الإتمام…'
            : state.attemptOutstanding
              ? 'إعادة الإرسال'
              : 'إتمام البيع'}
        </Button>
        {state.failure === null || state.attemptOutstanding ? null : (
          <Button variant="outline" size="lg" className="h-touch-lg" onClick={onDismiss}>
            إخفاء
          </Button>
        )}
      </div>
    </div>
  );
}
