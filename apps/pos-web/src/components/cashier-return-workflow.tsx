'use client';

import { useCallback, useMemo, useState } from 'react';
import { newId } from '@korvi/domain';
import { Button, CardSurface, Numeric } from '@korvi/ui';
import { StatusNote } from './status-note';
import { describeFailure } from '../lib/failures';
import { formatMinor } from '../lib/money';
import type { JSX } from 'react';
import type { TenderScheme } from '@korvi/domain';
import type { ApiClient } from '../lib/api';
import type {
  CreateReturnRequest,
  CreateReturnResponse,
  ReturnableSale,
  SaleLookupResult,
} from '../lib/api-types';

type LookupState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly sales: readonly SaleLookupResult[] }
  | { readonly kind: 'failed'; readonly message: string };

type SaleState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly sale: ReturnableSale }
  | { readonly kind: 'failed'; readonly message: string };

function scaledToText(value: string): string {
  const scaled = BigInt(value);
  const whole = scaled / 1000n;
  const fraction = (scaled % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

function parseQuantity(
  input: string,
  remainingScaled: string,
  productType: string | null,
): string | null {
  const trimmed = input.trim();
  const pattern = productType === 'unit' ? /^\d{1,12}$/ : /^\d{1,12}(?:\.\d{1,3})?$/;
  if (!pattern.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const scaled = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (scaled <= 0n || scaled > BigInt(remainingScaled)) return null;
  return scaled.toString();
}

function money(value: string, currency: string): JSX.Element {
  return (
    <span className="inline-flex items-baseline gap-1 tabular-nums" dir="ltr">
      <Numeric value={formatMinor(value)} />
      <span className="text-[11px] text-muted-foreground">{currency}</span>
    </span>
  );
}

export interface CashierReturnWorkflowProps {
  readonly api: ApiClient;
  readonly terminalId: string;
  readonly canRefund: boolean;
  readonly disabled: boolean;
  readonly onCommandLockChange: (locked: boolean) => void;
  readonly onExpired: () => void;
  readonly onShiftChanged: () => void;
}

export function CashierReturnWorkflow({
  api,
  terminalId,
  canRefund,
  disabled,
  onCommandLockChange,
  onExpired,
  onShiftChanged,
}: CashierReturnWorkflowProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [lookup, setLookup] = useState<LookupState>({ kind: 'idle' });
  const [saleState, setSaleState] = useState<SaleState>({ kind: 'idle' });
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [refundKind, setRefundKind] = useState<'cash' | 'electronic'>('cash');
  const [scheme, setScheme] = useState<TenderScheme>('mada');
  const [reference, setReference] = useState('');
  const [pending, setPending] = useState<CreateReturnRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [commandMessage, setCommandMessage] = useState<string | null>(null);
  const [result, setResult] = useState<CreateReturnResponse | null>(null);

  const selectedLines = useMemo(() => {
    if (saleState.kind !== 'ready') return [];
    return saleState.sale.lines.flatMap((line) => {
      const typed = quantities[line.saleLineId] ?? '';
      const parsed = parseQuantity(typed, line.remainingQuantityScaled, line.productType);
      return parsed === null ? [] : [{ saleLineId: line.saleLineId, quantityScaled: parsed }];
    });
  }, [quantities, saleState]);

  const reset = useCallback(() => {
    setQuery('');
    setLookup({ kind: 'idle' });
    setSaleState({ kind: 'idle' });
    setQuantities({});
    setReason('');
    setRefundKind('cash');
    setScheme('mada');
    setReference('');
    setPending(null);
    setSubmitting(false);
    setCommandMessage(null);
    setResult(null);
  }, []);

  const close = useCallback(() => {
    if (pending !== null || submitting) return;
    reset();
    setOpen(false);
    onCommandLockChange(false);
  }, [onCommandLockChange, pending, reset, submitting]);

  const begin = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    onCommandLockChange(true);
  }, [disabled, onCommandLockChange]);

  const search = useCallback(() => {
    const term = query.trim();
    if (term === '') return;
    setLookup({ kind: 'loading' });
    void api
      .saleLookup(term, 10)
      .then((sales) => setLookup({ kind: 'ready', sales }))
      .catch((error: unknown) => {
        const failure = describeFailure(error);
        if (failure.action === 'reauthenticate') onExpired();
        setLookup({ kind: 'failed', message: failure.message });
      });
  }, [api, onExpired, query]);

  const chooseSale = useCallback(
    (saleId: string) => {
      setSaleState({ kind: 'loading' });
      setCommandMessage(null);
      setResult(null);
      void api
        .returnableSale(saleId)
        .then((sale) => {
          setQuantities({});
          setSaleState({ kind: 'ready', sale });
        })
        .catch((error: unknown) => {
          const failure = describeFailure(error);
          if (failure.action === 'reauthenticate') onExpired();
          if (failure.action === 'refresh-shift' || failure.action === 'open-shift') onShiftChanged();
          setSaleState({ kind: 'failed', message: failure.message });
        });
    },
    [api, onExpired, onShiftChanged],
  );

  const execute = useCallback(
    (request: CreateReturnRequest) => {
      setPending(request);
      setSubmitting(true);
      setCommandMessage(null);
      void api
        .createReturn(request)
        .then((response) => {
          setResult(response);
          setPending(null);
          setCommandMessage(null);
        })
        .catch((error: unknown) => {
          const failure = describeFailure(error);
          if (failure.action === 'reauthenticate') onExpired();
          if (failure.action === 'refresh-shift' || failure.action === 'open-shift') onShiftChanged();
          setCommandMessage(failure.message);
          if (failure.action !== 'retry-same') setPending(null);
        })
        .finally(() => setSubmitting(false));
    },
    [api, onExpired, onShiftChanged],
  );

  const submit = useCallback(() => {
    if (saleState.kind !== 'ready' || selectedLines.length === 0 || submitting) return;
    if (refundKind === 'electronic' && reference.trim() === '') {
      setCommandMessage('أدخل مرجع عملية الاسترداد الإلكتروني قبل التنفيذ.');
      return;
    }
    const request: CreateReturnRequest = {
      operationId: newId(),
      terminalId,
      saleId: saleState.sale.saleId,
      ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
      refund:
        refundKind === 'cash'
          ? { kind: 'cash' }
          : { kind: 'electronic', scheme, reference: reference.trim() },
      lines: selectedLines,
    };
    execute(request);
  }, [
    execute,
    reason,
    reference,
    refundKind,
    saleState,
    scheme,
    selectedLines,
    submitting,
    terminalId,
  ]);

  if (!canRefund) return null;

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={begin}>
        مرتجع / استرداد
      </Button>
    );
  }

  return (
    <CardSurface className="mb-3 flex flex-col gap-3 border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">إنشاء مرتجع</p>
          <p className="text-xs text-muted-foreground">
            المبلغ المسترد يحسبه الخادم من الفاتورة الأصلية؛ لا يحدده الكاشير.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={pending !== null || submitting} onClick={close}>
          إغلاق
        </Button>
      </div>

      {result !== null ? (
        <div className="flex flex-col gap-3">
          <StatusNote tone="success" live>
            تم اعتماد المرتجع {result.return.returnNumber}. مبلغ الاسترداد المعتمد{' '}
            {result.return.refund === null
              ? '—'
              : formatMinor(result.return.refund.amountMinor)}{' '}
            {result.return.currency}.
          </StatusNote>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={reset}>
              مرتجع آخر
            </Button>
            <Button type="button" onClick={close}>
              تم
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <input
              className="h-touch min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
              value={query}
              disabled={submitting || pending !== null}
              placeholder="رقم الفاتورة أو رقم العملية"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') search();
              }}
            />
            <Button type="button" variant="outline" loading={lookup.kind === 'loading'} onClick={search}>
              بحث
            </Button>
          </div>

          {lookup.kind === 'failed' ? <StatusNote tone="danger">{lookup.message}</StatusNote> : null}
          {lookup.kind === 'ready' && lookup.sales.length === 0 ? (
            <StatusNote tone="info">لم يتم العثور على فاتورة مطابقة في هذا الفرع.</StatusNote>
          ) : null}
          {lookup.kind === 'ready' && lookup.sales.length > 0 && saleState.kind === 'idle' ? (
            <div className="max-h-44 overflow-y-auto rounded-md border border-border">
              {lookup.sales.map((sale) => (
                <button
                  key={sale.saleId}
                  type="button"
                  className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-start last:border-b-0 hover:bg-muted/60"
                  disabled={sale.fullyReturned}
                  onClick={() => chooseSale(sale.saleId)}
                >
                  <span>
                    <span className="block text-sm font-medium">
                      {sale.invoiceNumber ?? `#${String(sale.sequence)}`}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {sale.fullyReturned ? 'مُعاد بالكامل' : 'متاح للإرجاع'}
                    </span>
                  </span>
                  <span className="text-sm">{money(sale.totalMinor, sale.currency)}</span>
                </button>
              ))}
            </div>
          ) : null}

          {saleState.kind === 'loading' ? (
            <p className="text-sm text-muted-foreground" role="status">
              جارٍ قراءة الكميات المتبقية من الفاتورة…
            </p>
          ) : null}
          {saleState.kind === 'failed' ? (
            <StatusNote tone="danger">{saleState.message}</StatusNote>
          ) : null}

          {saleState.kind === 'ready' ? (
            <>
              <div className="flex items-center justify-between gap-3 rounded-md bg-muted/50 p-3 text-sm">
                <span>
                  {saleState.sale.invoiceNumber ?? 'فاتورة'}
                  <span className="ms-2 text-muted-foreground">المعتمد تاريخياً</span>
                </span>
                {money(saleState.sale.totalMinor, saleState.sale.currency)}
              </div>

              <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                {saleState.sale.lines.map((line) => (
                  <div
                    key={line.saleLineId}
                    className="grid grid-cols-[minmax(0,1fr)_8rem] items-center gap-3 border-b border-border p-3 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{line.nameAr}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        المتبقي: {scaledToText(line.remainingQuantityScaled)}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <input
                        className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-end text-sm"
                        inputMode="decimal"
                        value={quantities[line.saleLineId] ?? ''}
                        disabled={submitting || pending !== null || BigInt(line.remainingQuantityScaled) === 0n}
                        aria-label={`كمية إرجاع ${line.nameAr}`}
                        onChange={(event) =>
                          setQuantities((current) => ({
                            ...current,
                            [line.saleLineId]: event.target.value,
                          }))
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={submitting || pending !== null || BigInt(line.remainingQuantityScaled) === 0n}
                        onClick={() =>
                          setQuantities((current) => ({
                            ...current,
                            [line.saleLineId]: scaledToText(line.remainingQuantityScaled),
                          }))
                        }
                      >
                        الكل
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  طريقة الاسترداد
                  <select
                    className="h-touch rounded-md border border-input bg-background px-3 text-sm text-foreground"
                    value={refundKind}
                    disabled={submitting || pending !== null}
                    onChange={(event) =>
                      setRefundKind(event.target.value === 'electronic' ? 'electronic' : 'cash')
                    }
                  >
                    <option value="cash">نقدي</option>
                    <option value="electronic">إلكتروني</option>
                  </select>
                </label>

                {refundKind === 'electronic' ? (
                  <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                    الشبكة
                    <select
                      className="h-touch rounded-md border border-input bg-background px-3 text-sm text-foreground"
                      value={scheme}
                      disabled={submitting || pending !== null}
                      onChange={(event) => setScheme(event.target.value as TenderScheme)}
                    >
                      <option value="mada">مدى</option>
                      <option value="visa">Visa</option>
                      <option value="mastercard">Mastercard</option>
                      <option value="amex">Amex</option>
                      <option value="apple-pay">Apple Pay</option>
                      <option value="other">أخرى</option>
                    </select>
                  </label>
                ) : null}
              </div>

              {refundKind === 'electronic' ? (
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  مرجع الاسترداد من جهاز/مزود الدفع
                  <input
                    className="h-touch rounded-md border border-input bg-background px-3 text-sm text-foreground"
                    value={reference}
                    maxLength={64}
                    disabled={submitting || pending !== null}
                    onChange={(event) => setReference(event.target.value)}
                  />
                </label>
              ) : null}

              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                سبب المرتجع — اختياري
                <input
                  className="h-touch rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  value={reason}
                  maxLength={200}
                  disabled={submitting || pending !== null}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>

              {commandMessage === null ? null : (
                <StatusNote tone={pending === null ? 'danger' : 'warning'} live>
                  {commandMessage}
                </StatusNote>
              )}

              <div className="flex justify-end gap-2">
                {pending === null ? (
                  <Button
                    type="button"
                    disabled={selectedLines.length === 0 || submitting}
                    loading={submitting}
                    onClick={submit}
                  >
                    اعتماد المرتجع
                  </Button>
                ) : (
                  <Button type="button" loading={submitting} onClick={() => execute(pending)}>
                    إعادة نفس العملية
                  </Button>
                )}
              </div>
            </>
          ) : null}
        </>
      )}
    </CardSurface>
  );
}
