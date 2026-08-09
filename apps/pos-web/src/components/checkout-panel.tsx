'use client';

import { Button, Numeric } from '@korvi/ui';
import { Field } from './field';
import { StatusNote } from './status-note';
import { changeMinor, formatMinor } from '../lib/money';
import type { JSX, Ref } from 'react';
import type { CheckoutState } from '../lib/checkout';

/**
 * Cash, and what is owed back.
 *
 * The total shown here is a preview computed by the domain from the catalogue
 * prices the server sent. It is never what gets printed: the sale that comes
 * back from POST /v1/sales carries the figures, and those replace these.
 *
 * The button stays disabled while a request is in flight. That is the whole
 * defence against a double charge on this screen, and it is not optional.
 */
export interface CheckoutPanelProps {
  readonly totalMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly cash: string;
  readonly cashMinor: string | null;
  readonly lineCount: number;
  readonly locked: boolean;
  readonly state: CheckoutState;
  readonly cashRef: Ref<HTMLInputElement>;
  readonly onCashChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onDismiss: () => void;
}

export function CheckoutPanel({
  totalMinor,
  netMinor,
  vatMinor,
  cash,
  cashMinor,
  lineCount,
  locked,
  state,
  cashRef,
  onCashChange,
  onSubmit,
  onDismiss,
}: CheckoutPanelProps): JSX.Element {
  const change = cashMinor === null ? null : changeMinor(totalMinor, cashMinor);
  const submitting = state.phase === 'submitting';
  const blocked = state.failure?.action === 'blocking';
  const canSubmit = lineCount > 0 && cashMinor !== null && change !== null && !blocked;
  // The cash amount is part of the fingerprint the server compares. Editing it
  // while an attempt is outstanding would turn the retry into a different
  // intent, which the server would correctly refuse as a conflict.
  const cashFrozen = locked;

  return (
    <div className="flex shrink-0 flex-col gap-3 border-t border-border pt-3">
      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between text-muted-foreground">
          <dt>الإجمالي قبل الضريبة</dt>
          <dd>
            <Numeric value={formatMinor(netMinor)} />
          </dd>
        </div>
        <div className="flex items-center justify-between text-muted-foreground">
          <dt>ضريبة القيمة المضافة</dt>
          <dd>
            <Numeric value={formatMinor(vatMinor)} />
          </dd>
        </div>
        <div className="flex items-baseline justify-between pt-1">
          <dt className="text-base font-semibold text-card-foreground">المطلوب</dt>
          <dd>
            <Numeric
              value={formatMinor(totalMinor)}
              className="text-3xl font-bold text-foreground"
            />
          </dd>
        </div>
      </dl>

      <Field
        id="cash-received"
        label="النقد المستلم (ريال)"
        inputMode="decimal"
        autoComplete="off"
        dir="ltr"
        disabled={cashFrozen}
        invalid={cash.trim() !== '' && cashMinor === null}
        value={cash}
        inputRef={cashRef}
        className="h-touch-lg text-lg"
        onChange={(event) => {
          onCashChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && canSubmit && !submitting && !cashFrozen) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />

      <div className="flex items-baseline justify-between rounded-md bg-muted px-3 py-2 text-sm">
        <span className="text-muted-foreground">الباقي</span>
        {change === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <Numeric value={formatMinor(change)} className="text-lg font-semibold text-foreground" />
        )}
      </div>

      {state.failure === null ? null : (
        <StatusNote tone={state.failure.action === 'blocking' ? 'danger' : 'warning'} live>
          {state.failure.message}
        </StatusNote>
      )}

      {state.attemptOutstanding ? (
        <StatusNote tone="warning">
          لم تصل نتيجة العملية. السلة مقفلة كما هي — أعد الإرسال بنفس العملية، ولا تُنشئ عملية
          جديدة.
        </StatusNote>
      ) : null}

      <div className="flex gap-2">
        <Button
          size="lg"
          className="flex-1"
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
          <Button variant="outline" size="lg" onClick={onDismiss}>
            إخفاء
          </Button>
        )}
      </div>
    </div>
  );
}
