'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { newId } from '@korvi/domain';
import { Button, CardSurface, Numeric } from '@korvi/ui';
import { StatusNote } from './status-note';
import { previewCart } from '../lib/cart';
import { describeFailure } from '../lib/failures';
import { formatMinor, parseSarToMinor } from '../lib/money';
import {
  emptyElectronicTender,
  planPayment,
  type ElectronicTenderDraft,
  type PaymentMode,
} from '../lib/payment-tenders';
import type { CartLine } from '../lib/cart';
import type { ApiClient } from '../lib/api';
import type {
  NoReceiptExchangeReason,
  NoReceiptExchangeRequest,
  NoReceiptExchangeResponse,
  ProductSummary,
} from '../lib/api-types';
import type { PriceMode, TenderScheme } from '@korvi/domain';
import type { JSX } from 'react';

interface AcceptedDraft {
  readonly product: ProductSummary;
  readonly quantity: string;
}

type SearchState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly products: readonly ProductSummary[] }
  | { readonly kind: 'failed'; readonly message: string };

const REASONS: readonly [NoReceiptExchangeReason, string][] = [
  ['customer-no-receipt', 'العميل لا يملك الفاتورة'],
  ['gift-return', 'استبدال هدية'],
  ['receipt-unavailable', 'الفاتورة غير متاحة'],
  ['manager-exception', 'استثناء معتمد من المشرف'],
  ['other', 'سبب آخر'],
];

const SCHEMES: readonly [TenderScheme, string][] = [
  ['mada', 'مدى'],
  ['visa', 'Visa'],
  ['mastercard', 'Mastercard'],
  ['amex', 'Amex'],
  ['apple-pay', 'Apple Pay'],
  ['other', 'أخرى'],
];

function parseQuantity(value: string, productType: ProductSummary['productType']): string | null {
  const trimmed = value.trim();
  const pattern = productType === 'unit' ? /^\d{1,12}$/ : /^\d{1,12}(?:\.\d{1,3})?$/;
  if (!pattern.test(trimmed)) return null;
  const parts = trimmed.split('.');
  const whole = parts[0] ?? '0';
  const fraction = parts[1] ?? '';
  const scaled = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  return scaled > 0n ? scaled.toString() : null;
}

function acceptedPreview(lines: readonly AcceptedDraft[], priceMode: PriceMode): string | null {
  if (lines.length === 0) return null;
  const cartLines: CartLine[] = [];
  for (const line of lines) {
    const quantityScaled = parseQuantity(line.quantity, line.product.productType);
    if (quantityScaled === null) return null;
    cartLines.push({
      productId: line.product.id,
      sku: line.product.sku,
      nameAr: line.product.nameAr,
      nameEn: line.product.nameEn,
      productType: line.product.productType,
      unitLabel: line.product.unitLabel,
      unitPriceMinor: line.product.priceMinor,
      vatBasisPoints: line.product.vatBasisPoints,
      quantityScaled,
    });
  }
  return previewCart(cartLines, priceMode).total.minor.toString();
}

export interface NoReceiptExchangeWorkflowProps {
  readonly api: ApiClient;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly priceMode: PriceMode;
  readonly replacementLines: readonly CartLine[];
  readonly replacementTotalMinor: string;
  readonly canExchange: boolean;
  readonly disabled: boolean;
  readonly onCommandLockChange: (locked: boolean) => void;
  readonly onExpired: () => void;
  readonly onShiftChanged: () => void;
  readonly onCompleted: () => void;
}

export function NoReceiptExchangeWorkflow({
  api,
  terminalId,
  shiftId,
  priceMode,
  replacementLines,
  replacementTotalMinor,
  canExchange,
  disabled,
  onCommandLockChange,
  onExpired,
  onShiftChanged,
  onCompleted,
}: NoReceiptExchangeWorkflowProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [online, setOnline] = useState(true);
  const [query, setQuery] = useState('');
  const [searchState, setSearchState] = useState<SearchState>({ kind: 'idle' });
  const [accepted, setAccepted] = useState<readonly AcceptedDraft[]>([]);
  const [reason, setReason] = useState<NoReceiptExchangeReason>('customer-no-receipt');
  const [evidenceNote, setEvidenceNote] = useState('');
  const [allowance, setAllowance] = useState('');
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [cash, setCash] = useState('');
  const [electronicTenders, setElectronicTenders] = useState<readonly ElectronicTenderDraft[]>([
    emptyElectronicTender(),
  ]);
  const [pending, setPending] = useState<NoReceiptExchangeRequest | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<NoReceiptExchangeResponse | null>(null);

  useEffect(() => {
    const update = (): void => setOnline(globalThis.navigator?.onLine ?? true);
    update();
    globalThis.addEventListener?.('online', update);
    globalThis.addEventListener?.('offline', update);
    return () => {
      globalThis.removeEventListener?.('online', update);
      globalThis.removeEventListener?.('offline', update);
    };
  }, []);

  const ceilingMinor = useMemo(() => acceptedPreview(accepted, priceMode), [accepted, priceMode]);
  const allowanceMinor = useMemo(() => {
    const parsed = parseSarToMinor(allowance);
    return parsed.ok ? parsed.value : null;
  }, [allowance]);
  const remainingMinor =
    allowanceMinor === null
      ? null
      : (BigInt(replacementTotalMinor) - BigInt(allowanceMinor)).toString();
  const payment = useMemo(() => {
    if (remainingMinor === null || BigInt(remainingMinor) < 0n) return null;
    if (remainingMinor === '0') {
      return {
        valid: true,
        message: null,
        tenders: [],
      } as const;
    }
    return planPayment(remainingMinor, paymentMode, cash, electronicTenders);
  }, [cash, electronicTenders, paymentMode, remainingMinor]);

  const reset = useCallback(() => {
    setQuery('');
    setSearchState({ kind: 'idle' });
    setAccepted([]);
    setReason('customer-no-receipt');
    setEvidenceNote('');
    setAllowance('');
    setPaymentMode('cash');
    setCash('');
    setElectronicTenders([emptyElectronicTender()]);
    setPending(null);
    setSubmitting(false);
    setMessage(null);
    setResult(null);
  }, []);

  const close = useCallback(() => {
    if (pending !== null || submitting) return;
    reset();
    setOpen(false);
    onCommandLockChange(false);
  }, [onCommandLockChange, pending, reset, submitting]);

  const begin = useCallback(() => {
    if (disabled || replacementLines.length === 0) return;
    setOpen(true);
    onCommandLockChange(true);
  }, [disabled, onCommandLockChange, replacementLines.length]);

  const search = useCallback(() => {
    const term = query.trim();
    if (term === '') return;
    setSearchState({ kind: 'loading' });
    void api
      .products({ q: term, limit: 12 })
      .then((products) => setSearchState({ kind: 'ready', products }))
      .catch((error: unknown) => {
        const failure = describeFailure(error);
        if (failure.action === 'reauthenticate') onExpired();
        setSearchState({ kind: 'failed', message: failure.message });
      });
  }, [api, onExpired, query]);

  const addAccepted = useCallback((product: ProductSummary) => {
    setAccepted((current) =>
      current.some((line) => line.product.id === product.id)
        ? current
        : [...current, { product, quantity: '1' }],
    );
    setSearchState({ kind: 'idle' });
    setQuery('');
  }, []);

  const execute = useCallback(
    (request: NoReceiptExchangeRequest) => {
      if (!online || submitting) return;
      setPending(request);
      setSubmitting(true);
      setMessage(null);
      void api
        .createNoReceiptExchange(request)
        .then((response) => {
          setResult(response);
          setPending(null);
        })
        .catch((error: unknown) => {
          const failure = describeFailure(error);
          if (failure.action === 'reauthenticate') onExpired();
          if (failure.action === 'refresh-shift' || failure.action === 'open-shift') {
            onShiftChanged();
          }
          setMessage(failure.message);
          if (failure.action !== 'retry-same') setPending(null);
        })
        .finally(() => setSubmitting(false));
    },
    [api, onExpired, online, onShiftChanged, submitting],
  );

  const submit = useCallback(() => {
    if (!online || submitting || pending !== null) return;
    const acceptedLines: { productId: string; quantityScaled: string }[] = [];
    for (const line of accepted) {
      const quantityScaled = parseQuantity(line.quantity, line.product.productType);
      if (quantityScaled === null) {
        setMessage('راجع كميات الأصناف المستلمة.');
        return;
      }
      acceptedLines.push({ productId: line.product.id, quantityScaled });
    }
    if (acceptedLines.length === 0) {
      setMessage('أضف صنفاً مستلماً واحداً على الأقل.');
      return;
    }
    if (
      allowanceMinor === null ||
      ceilingMinor === null ||
      BigInt(allowanceMinor) > BigInt(ceilingMinor)
    ) {
      setMessage('قيمة الاستبدال يجب أن تكون ضمن الحد المرجعي الحالي.');
      return;
    }
    if (BigInt(replacementTotalMinor) < BigInt(allowanceMinor)) {
      setMessage('إجمالي البيع البديل أقل من قيمة الاستبدال المعتمدة.');
      return;
    }
    if (payment === null || !payment.valid) {
      setMessage(payment?.message ?? 'راجع دفع المبلغ الإضافي.');
      return;
    }

    execute({
      operationId: newId(),
      terminalId,
      expectedShiftId: shiftId,
      reason,
      ...(evidenceNote.trim() === '' ? {} : { evidenceNote: evidenceNote.trim() }),
      approvedAllowanceMinor: allowanceMinor,
      acceptedLines,
      replacementLines: replacementLines.map((line) => ({
        productId: line.productId,
        quantityScaled: line.quantityScaled,
      })),
      tenders: payment.tenders,
    });
  }, [
    accepted,
    allowanceMinor,
    ceilingMinor,
    evidenceNote,
    execute,
    online,
    payment,
    pending,
    reason,
    replacementLines,
    replacementTotalMinor,
    shiftId,
    submitting,
    terminalId,
  ]);

  if (!canExchange) return null;

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || replacementLines.length === 0}
        onClick={begin}
      >
        استبدال بدون فاتورة
      </Button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[75] flex items-start justify-center overflow-y-auto bg-background/80 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="استبدال بدون فاتورة"
    >
      <CardSurface className="my-auto flex w-full max-w-4xl flex-col gap-4 border-border p-4 shadow-lg sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-base font-semibold">استبدال بدون فاتورة</p>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              لا توجد فاتورة أصلية مستخدمة في هذه العملية. الأسعار والضريبة أدناه مرجع سياسة حالي
              فقط، ولا تمثل سعراً أو ضريبة أو خصماً أو وسيلة دفع تاريخية.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending !== null || submitting}
            onClick={close}
          >
            إغلاق
          </Button>
        </div>

        {!online ? (
          <StatusNote tone="warning" live>
            هذه العملية تتطلب اتصالاً بالخادم ولا تُحفظ في قائمة البيع دون اتصال.
          </StatusNote>
        ) : null}

        {result !== null ? (
          <div className="space-y-3">
            <StatusNote tone="success" live>
              تم اعتماد الحالة {result.exchange.caseNumber} وربطها بالبيع البديل{' '}
              {result.sale.invoiceNumber}.
            </StatusNote>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">قيمة الاستبدال</p>
                <p className="mt-1 text-lg font-semibold">
                  <Numeric value={formatMinor(result.exchange.approvedAllowanceMinor)} /> ر.س
                </p>
              </div>
              <div className="rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">البيع البديل</p>
                <p className="mt-1 text-lg font-semibold">
                  <Numeric value={formatMinor(result.sale.totalMinor)} /> ر.س
                </p>
              </div>
              <div className="rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">المدفوع فوق الاستبدال</p>
                <p className="mt-1 text-lg font-semibold">
                  <Numeric
                    value={formatMinor(
                      (
                        BigInt(result.sale.totalMinor) -
                        BigInt(result.exchange.approvedAllowanceMinor)
                      ).toString(),
                    )}
                  />{' '}
                  ر.س
                </p>
              </div>
            </div>
            <StatusNote tone="info">
              الأصناف المتتبعة عادت إلى المخزون القابل للبيع بتكلفة تاريخية غير معروفة؛ لم تُسجل
              تكلفة صفرية معروفة ولم تُنسخ تكلفة حالية كحقيقة تاريخية.
            </StatusNote>
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => {
                  close();
                  onCompleted();
                }}
              >
                تم وابدأ بيعاً جديداً
              </Button>
            </div>
          </div>
        ) : (
          <>
            <section className="space-y-3">
              <div>
                <p className="text-sm font-semibold">الأصناف المستلمة بدون فاتورة</p>
                <p className="text-xs text-muted-foreground">
                  أصناف معروفة في كتالوج Korvi فقط. المخزون المتتبع سيعود كقابل للبيع.
                </p>
              </div>
              <div className="flex gap-2">
                <input
                  className="h-touch min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm"
                  value={query}
                  disabled={submitting || pending !== null}
                  placeholder="ابحث بالاسم أو الباركود أو SKU"
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') search();
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  loading={searchState.kind === 'loading'}
                  onClick={search}
                >
                  بحث
                </Button>
              </div>
              {searchState.kind === 'failed' ? (
                <StatusNote tone="danger">{searchState.message}</StatusNote>
              ) : null}
              {searchState.kind === 'ready' && searchState.products.length > 0 ? (
                <div className="max-h-36 overflow-y-auto rounded-md border border-border">
                  {searchState.products.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-start last:border-b-0 hover:bg-muted/60"
                      onClick={() => addAccepted(product)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{product.nameAr}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {product.sku}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs">
                        {formatMinor(product.priceMinor)} ر.س
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="rounded-md border border-border">
                {accepted.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">لم تتم إضافة أصناف بعد.</p>
                ) : (
                  accepted.map((line) => (
                    <div
                      key={line.product.id}
                      className="grid grid-cols-[minmax(0,1fr)_7rem_auto] items-center gap-2 border-b border-border p-2 last:border-b-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{line.product.nameAr}</p>
                        <p className="text-[11px] text-muted-foreground">
                          مرجع اليوم: {formatMinor(line.product.priceMinor)} ر.س
                        </p>
                      </div>
                      <input
                        aria-label={'كمية ' + line.product.nameAr}
                        className="h-9 rounded-md border border-input bg-background px-2 text-end text-sm"
                        inputMode="decimal"
                        value={line.quantity}
                        disabled={submitting || pending !== null}
                        onChange={(event) =>
                          setAccepted((current) =>
                            current.map((entry) =>
                              entry.product.id === line.product.id
                                ? { ...entry, quantity: event.target.value }
                                : entry,
                            ),
                          )
                        }
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={submitting || pending !== null}
                        onClick={() =>
                          setAccepted((current) =>
                            current.filter((entry) => entry.product.id !== line.product.id),
                          )
                        }
                      >
                        حذف
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </section>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">الحد المرجعي الحالي الأقصى</p>
                <p className="mt-1 text-xl font-semibold">
                  {ceilingMinor === null ? '—' : formatMinor(ceilingMinor)} ر.س
                </p>
              </div>
              <div className="rounded-md bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">سلة البيع البديل الحالية</p>
                <p className="mt-1 text-xl font-semibold">
                  {formatMinor(replacementTotalMinor)} ر.س
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {String(replacementLines.length)} صنف — أغلق النافذة لتعديل السلة.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                السبب
                <select
                  className="h-touch rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  value={reason}
                  disabled={submitting || pending !== null}
                  onChange={(event) => setReason(event.target.value as NoReceiptExchangeReason)}
                >
                  {REASONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                قيمة الاستبدال المعتمدة (ريال)
                <input
                  className="h-touch rounded-md border border-input bg-background px-3 text-sm"
                  inputMode="decimal"
                  dir="ltr"
                  value={allowance}
                  disabled={submitting || pending !== null}
                  placeholder="0.00"
                  onChange={(event) => setAllowance(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                ملاحظة إثبات — اختيارية
                <input
                  className="h-touch rounded-md border border-input bg-background px-3 text-sm"
                  value={evidenceNote}
                  maxLength={500}
                  disabled={submitting || pending !== null}
                  onChange={(event) => setEvidenceNote(event.target.value)}
                />
              </label>
            </div>

            <section className="space-y-3 rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">الدفع الإضافي</p>
                  <p className="text-xs text-muted-foreground">
                    لا نقد ولا رصيد متبقٍ يخرج من قيمة الاستبدال.
                  </p>
                </div>
                <p className="text-lg font-semibold">
                  {remainingMinor === null || BigInt(remainingMinor) < 0n
                    ? '—'
                    : formatMinor(remainingMinor) + ' ر.س'}
                </p>
              </div>

              {remainingMinor === '0' ? (
                <StatusNote tone="info">لا يوجد مبلغ إضافي مستحق.</StatusNote>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant={paymentMode === 'cash' ? 'secondary' : 'outline'}
                      disabled={submitting || pending !== null}
                      onClick={() => setPaymentMode('cash')}
                    >
                      نقدي
                    </Button>
                    <Button
                      type="button"
                      variant={paymentMode === 'mixed' ? 'secondary' : 'outline'}
                      disabled={submitting || pending !== null}
                      onClick={() => setPaymentMode('mixed')}
                    >
                      إلكتروني / متعدد
                    </Button>
                  </div>
                  <input
                    aria-label="المبلغ النقدي الإضافي"
                    className="h-touch rounded-md border border-input bg-background px-3 text-sm"
                    inputMode="decimal"
                    dir="ltr"
                    value={cash}
                    disabled={submitting || pending !== null}
                    placeholder={paymentMode === 'cash' ? 'النقد المستلم' : 'جزء نقدي اختياري'}
                    onChange={(event) => setCash(event.target.value)}
                  />
                  {paymentMode === 'mixed' ? (
                    <div className="space-y-2">
                      {electronicTenders.map((tender, index) => (
                        <div
                          key={index}
                          className="grid grid-cols-[minmax(5rem,.7fr)_minmax(5rem,.7fr)_minmax(7rem,1fr)_auto] gap-2"
                        >
                          <select
                            className="h-touch rounded-md border border-input bg-background px-2 text-sm"
                            value={tender.scheme}
                            disabled={submitting || pending !== null}
                            onChange={(event) =>
                              setElectronicTenders((current) =>
                                current.map((entry, entryIndex) =>
                                  entryIndex === index
                                    ? { ...entry, scheme: event.target.value as TenderScheme }
                                    : entry,
                                ),
                              )
                            }
                          >
                            {SCHEMES.map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                          <input
                            className="h-touch rounded-md border border-input bg-background px-2 text-sm"
                            inputMode="decimal"
                            dir="ltr"
                            value={tender.amount}
                            disabled={submitting || pending !== null}
                            placeholder="المبلغ"
                            onChange={(event) =>
                              setElectronicTenders((current) =>
                                current.map((entry, entryIndex) =>
                                  entryIndex === index
                                    ? { ...entry, amount: event.target.value }
                                    : entry,
                                ),
                              )
                            }
                          />
                          <input
                            className="h-touch rounded-md border border-input bg-background px-2 text-sm"
                            dir="ltr"
                            value={tender.reference}
                            maxLength={64}
                            disabled={submitting || pending !== null}
                            placeholder="مرجع الموافقة"
                            onChange={(event) =>
                              setElectronicTenders((current) =>
                                current.map((entry, entryIndex) =>
                                  entryIndex === index
                                    ? { ...entry, reference: event.target.value }
                                    : entry,
                                ),
                              )
                            }
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={
                              submitting || pending !== null || electronicTenders.length <= 1
                            }
                            onClick={() =>
                              setElectronicTenders((current) =>
                                current.filter((_, entryIndex) => entryIndex !== index),
                              )
                            }
                          >
                            حذف
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={submitting || pending !== null || electronicTenders.length >= 7}
                        onClick={() =>
                          setElectronicTenders((current) => [...current, emptyElectronicTender()])
                        }
                      >
                        إضافة دفعة إلكترونية
                      </Button>
                    </div>
                  ) : null}
                  {payment === null || payment.message === null ? null : (
                    <p className="text-xs text-muted-foreground">{payment.message}</p>
                  )}
                </>
              )}
            </section>

            {message === null ? null : (
              <StatusNote tone={pending === null ? 'danger' : 'warning'} live>
                {message}
              </StatusNote>
            )}

            <div className="flex justify-end">
              {pending === null ? (
                <Button
                  type="button"
                  loading={submitting}
                  disabled={!online || submitting}
                  onClick={submit}
                >
                  اعتماد الحالة والبيع البديل
                </Button>
              ) : (
                <Button
                  type="button"
                  loading={submitting}
                  disabled={!online || submitting}
                  onClick={() => execute(pending)}
                >
                  إعادة نفس العملية
                </Button>
              )}
            </div>
          </>
        )}
      </CardSurface>
    </div>
  );
}
