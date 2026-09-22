'use client';

import { useCallback, useState } from 'react';
import { newId } from '@korvi/domain';
import { Button, CardSurface, Numeric } from '@korvi/ui';
import { StatusNote } from './status-note';
import { describeFailure } from '../lib/failures';
import { formatMinor, parseSarToPostgresMinor } from '../lib/money';
import type { JSX } from 'react';
import type { ApiClient } from '../lib/api';
import type { ShiftCloseRequest, ShiftCloseResponse, ShiftSummary } from '../lib/api-types';

export interface ShiftCloseControlProps {
  readonly api: ApiClient;
  readonly terminalId: string;
  readonly shift: ShiftSummary;
  readonly canClose: boolean;
  readonly disabled: boolean;
  readonly onCommandLockChange: (locked: boolean) => void;
  readonly onExpired: () => void;
  readonly onClosed: () => void;
}

function Amount({ value }: { readonly value: string }): JSX.Element {
  return (
    <span className="inline-flex items-baseline gap-1 tabular-nums" dir="ltr">
      <Numeric value={formatMinor(value)} />
      <span className="text-[11px] text-muted-foreground">SAR</span>
    </span>
  );
}

export function ShiftCloseControl({
  api,
  terminalId,
  shift,
  canClose,
  disabled,
  onCommandLockChange,
  onExpired,
  onClosed,
}: ShiftCloseControlProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [declaredCash, setDeclaredCash] = useState('');
  const [pending, setPending] = useState<ShiftCloseRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<ShiftCloseResponse | null>(null);

  const begin = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    setMessage(null);
    onCommandLockChange(true);
  }, [disabled, onCommandLockChange]);

  const cancel = useCallback(() => {
    if (pending !== null || submitting || result !== null) return;
    setOpen(false);
    setDeclaredCash('');
    setMessage(null);
    onCommandLockChange(false);
  }, [onCommandLockChange, pending, result, submitting]);

  const execute = useCallback(
    (request: ShiftCloseRequest) => {
      setPending(request);
      setSubmitting(true);
      setMessage(null);
      void api
        .closeShift(request)
        .then((response) => {
          setResult(response);
          setPending(null);
        })
        .catch((error: unknown) => {
          const failure = describeFailure(error);
          if (failure.action === 'reauthenticate') onExpired();
          setMessage(failure.message);
          if (failure.action !== 'retry-same') setPending(null);
        })
        .finally(() => setSubmitting(false));
    },
    [api, onExpired],
  );

  const submit = useCallback(() => {
    const parsed = parseSarToPostgresMinor(declaredCash);
    if (!parsed.ok || submitting) {
      setMessage('أدخل المبلغ النقدي الفعلي الذي تم عده في الدرج.');
      return;
    }
    execute({
      operationId: newId(),
      terminalId,
      shiftId: shift.id,
      declaredCashMinor: parsed.value,
    });
  }, [declaredCash, execute, shift.id, submitting, terminalId]);

  const finish = useCallback(() => {
    onCommandLockChange(false);
    onClosed();
  }, [onClosed, onCommandLockChange]);

  if (!canClose) return null;

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={begin}>
        إغلاق الوردية
      </Button>
    );
  }

  return (
    <CardSurface className="mb-3 flex flex-col gap-3 border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">إغلاق الوردية وتسوية الدرج</p>
          <p className="text-xs text-muted-foreground">
            عدّ النقد فعلياً أولاً. المتوقع والفارق لا يظهران إلا بعد اعتماد العد.
          </p>
        </div>
        {result === null ? (
          <Button type="button" variant="ghost" size="sm" disabled={pending !== null || submitting} onClick={cancel}>
            إلغاء
          </Button>
        ) : null}
      </div>

      {result === null ? (
        <>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            النقد الفعلي في الدرج — SAR
            <input
              className="h-touch rounded-md border border-input bg-background px-3 text-end text-base text-foreground"
              inputMode="decimal"
              value={declaredCash}
              disabled={submitting || pending !== null}
              autoFocus
              onChange={(event) => setDeclaredCash(event.target.value)}
            />
          </label>

          {message === null ? null : (
            <StatusNote tone={pending === null ? 'danger' : 'warning'} live>
              {message}
            </StatusNote>
          )}

          <div className="flex justify-end">
            {pending === null ? (
              <Button type="button" loading={submitting} onClick={submit}>
                اعتماد العد وإغلاق الوردية
              </Button>
            ) : (
              <Button type="button" loading={submitting} onClick={() => execute(pending)}>
                إعادة نفس عملية الإغلاق
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          <StatusNote tone="success" live>
            أغلقت الوردية واعتمدت التسوية من الخادم.
          </StatusNote>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-md bg-muted/50 p-2">
              <dt className="text-xs text-muted-foreground">رصيد البداية</dt>
              <dd className="mt-1"><Amount value={result.shift.reconciliation.openingFloatMinor} /></dd>
            </div>
            <div className="rounded-md bg-muted/50 p-2">
              <dt className="text-xs text-muted-foreground">المبيعات النقدية</dt>
              <dd className="mt-1"><Amount value={result.shift.reconciliation.cashSalesMinor} /></dd>
            </div>
            <div className="rounded-md bg-muted/50 p-2">
              <dt className="text-xs text-muted-foreground">المرتجعات النقدية</dt>
              <dd className="mt-1"><Amount value={result.shift.reconciliation.cashRefundsMinor} /></dd>
            </div>
            <div className="rounded-md bg-muted/50 p-2">
              <dt className="text-xs text-muted-foreground">إيداع / سحب يدوي</dt>
              <dd className="mt-1">
                <Amount value={result.shift.reconciliation.paidInMinor} />
                <span className="mx-1 text-muted-foreground">/</span>
                <Amount value={result.shift.reconciliation.paidOutMinor} />
              </dd>
            </div>
            <div className="rounded-md bg-muted/50 p-2">
              <dt className="text-xs text-muted-foreground">المتوقع</dt>
              <dd className="mt-1 font-semibold"><Amount value={result.shift.reconciliation.expectedCashMinor} /></dd>
            </div>
            <div className="rounded-md bg-muted/50 p-2">
              <dt className="text-xs text-muted-foreground">المعدود</dt>
              <dd className="mt-1 font-semibold"><Amount value={result.shift.reconciliation.declaredCashMinor} /></dd>
            </div>
            <div className="col-span-2 rounded-md border border-border p-2">
              <dt className="text-xs text-muted-foreground">الفارق (المعدود − المتوقع)</dt>
              <dd className="mt-1 text-lg font-semibold"><Amount value={result.shift.reconciliation.varianceMinor} /></dd>
            </div>
          </dl>
          <div className="flex justify-end">
            <Button type="button" onClick={finish}>
              إنهاء والعودة
            </Button>
          </div>
        </>
      )}
    </CardSurface>
  );
}
