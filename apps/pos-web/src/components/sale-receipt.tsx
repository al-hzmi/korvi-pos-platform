'use client';

import { useRef, useState } from 'react';
import { BidiIsolate, Button, CardSurface, Numeric } from '@korvi/ui';
import { StatusNote } from './status-note';
import { formatMinor } from '../lib/money';
import { formatScaled } from '../lib/quantity';
import { formatTimestamp } from '../lib/datetime';
import { createReceiptPrintFlight } from '../lib/receipt-print-flight';
import type { JSX } from 'react';
import type { FiscalReceipt, SaleSummary } from '../lib/api-types';
import type { FiscalReceiptPrinter, ReceiptPrintFlight } from '../lib/receipt-print-flight';

/**
 * The sale, as the server recorded it.
 *
 * Every figure below comes from the response. Nothing is recomputed from the
 * cart, which by now is stale by definition: the server priced the sale from
 * its own catalogue, allocated the receipt number inside the transaction, and
 * decided the change. Re-deriving any of it here would be inventing a second
 * opinion about a tax document.
 */
export interface SaleReceiptProps {
  readonly sale: SaleSummary;
  readonly receipt: FiscalReceipt | null;
  readonly replayed: boolean;
  readonly orderNumber?: string | null;
  readonly printFiscalReceipt?: FiscalReceiptPrinter | undefined;
  readonly onNewSale: () => void;
}

type PrintState = 'idle' | 'printing' | 'printed' | 'failed';

function tenderLabel(kind: string, scheme: string | null): string {
  if (kind === 'cash') return 'نقدي';
  if (scheme === 'mada') return 'مدى';
  if (scheme === 'visa') return 'Visa';
  if (scheme === 'mastercard') return 'Mastercard';
  if (scheme === 'amex') return 'Amex';
  if (scheme === 'apple-pay') return 'Apple Pay';
  return scheme ?? 'إلكتروني';
}

export function SaleReceipt({
  sale,
  receipt,
  replayed,
  orderNumber,
  printFiscalReceipt,
  onNewSale,
}: SaleReceiptProps): JSX.Element {
  const [printState, setPrintState] = useState<PrintState>('idle');
  const printFlight = useRef<ReceiptPrintFlight | null>(null);
  if (printFlight.current === null) printFlight.current = createReceiptPrintFlight();
  const isSimulation = receipt?.fiscalizationMode === 'simulation';

  const print = async () => {
    if (receipt === null || printFiscalReceipt === undefined) return;
    setPrintState('printing');
    try {
      const outcome = await printFlight.current!.run(() => printFiscalReceipt(sale, receipt));
      if (outcome === 'printed') setPrintState('printed');
    } catch {
      setPrintState('failed');
    }
  };

  const printLabel =
    printState === 'printing'
      ? `جارٍ إرسال ${isSimulation ? 'إيصال المحاكاة' : 'الفاتورة'} للطابعة…`
      : printState === 'failed'
        ? `إعادة محاولة طباعة نفس ${isSimulation ? 'الإيصال' : 'الفاتورة'}`
        : printState === 'printed'
          ? `إعادة طباعة نفس ${isSimulation ? 'الإيصال' : 'الفاتورة'}`
          : isSimulation
            ? 'طباعة إيصال المحاكاة'
            : 'طباعة الفاتورة الضريبية';

  return (
    <CardSurface className="flex min-h-0 flex-1 flex-col gap-4 border-border/80 p-4 shadow-sm">
      <div className="rounded-lg border border-success/20 bg-success/5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="inline-flex w-fit items-center rounded-md bg-success/10 px-2 py-1 text-xs font-semibold text-success ring-1 ring-inset ring-success/30">
              {replayed ? 'عملية مسجّلة مسبقاً' : 'تمّت العملية بنجاح'}
            </span>
            <h2 className="mt-1 truncate text-lg font-semibold text-card-foreground">
              {isSimulation ? 'إيصال محاكاة' : 'فاتورة'}{' '}
              <BidiIsolate>{sale.invoiceNumber}</BidiIsolate>
            </h2>
            <p className="text-xs text-muted-foreground">
              الكاشير {sale.cashierName} ·{' '}
              <BidiIsolate>{formatTimestamp(sale.issuedAt)}</BidiIsolate>
            </p>
            {orderNumber === undefined || orderNumber === null ? null : (
              <p className="text-sm font-semibold text-card-foreground">
                رقم الطلب <BidiIsolate>{orderNumber}</BidiIsolate>
              </p>
            )}
          </div>
          <span className="flex shrink-0 items-baseline gap-1 text-success">
            <Numeric
              value={formatMinor(sale.totalMinor)}
              className="text-3xl font-bold tracking-tight"
            />
            <span className="text-xs font-semibold">ر.س</span>
          </span>
        </div>
      </div>

      {isSimulation ? (
        <StatusNote tone="warning" live>
          <span dir="ltr">SIMULATION / NOT FOR TAX USE</span>
          {' — '}محاكاة فقط، غير صالح للاستخدام الضريبي ولا يمثل امتثال ZATCA إنتاجيًا.
        </StatusNote>
      ) : null}

      {receipt === null ? (
        <StatusNote tone="danger" live>
          تم حفظ البيع، لكن الخادم لم يُرجع الفاتورة الضريبية المختومة. لا تنشئ بيعاً بديلاً ولا
          تحاول إعادة الدفع.
        </StatusNote>
      ) : printFiscalReceipt === undefined ? (
        <StatusNote tone="warning" live>
          {isSimulation
            ? 'إيصال المحاكاة جاهز، لكن هذا المضيف لا يوفّر طابعة محلية.'
            : 'الفاتورة مختومة، لكن هذا المضيف لا يوفّر طابعة فواتير محلية.'}
        </StatusNote>
      ) : printState === 'failed' ? (
        <StatusNote tone="warning" live>
          تم البيع، لكن تعذّرت الطباعة. أعد المحاولة لطباعة نفس{' '}
          {isSimulation ? 'إيصال المحاكاة' : 'الفاتورة'} دون إنشاء بيع جديد.
        </StatusNote>
      ) : printState === 'printed' ? (
        <StatusNote tone="success" live>
          أُرسل نفس {isSimulation ? 'إيصال المحاكاة' : 'الفاتورة الضريبية المختومة'} إلى الطابعة.
          يمكن إعادة طباعته دون تغيير البيع.
        </StatusNote>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
        <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs font-semibold text-muted-foreground">
          تفاصيل البيع
        </div>
        <ul className="max-h-full overflow-y-auto px-3">
          {sale.lines.map((line) => (
            <li
              key={line.lineNumber}
              className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-b-0"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-sm font-medium text-card-foreground">
                  {line.nameAr}
                </span>
                <span className="text-xs text-muted-foreground">
                  <Numeric value={formatScaled(line.quantityScaled)} />
                  {' × '}
                  <Numeric value={formatMinor(line.unitPriceMinor)} />
                </span>
              </span>
              <span className="flex shrink-0 items-baseline gap-1">
                <Numeric value={formatMinor(line.totalMinor)} className="text-sm font-semibold" />
                <span className="text-[10px] text-muted-foreground">ر.س</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <dl className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3 text-sm">
        <div className="flex items-center justify-between text-muted-foreground">
          <dt>قبل الضريبة</dt>
          <dd>
            <Numeric value={formatMinor(sale.netMinor)} />
          </dd>
        </div>
        <div className="flex items-center justify-between text-muted-foreground">
          <dt>ضريبة القيمة المضافة</dt>
          <dd>
            <Numeric value={formatMinor(sale.vatMinor)} />
          </dd>
        </div>
        <div className="flex items-center justify-between border-t border-border pt-2">
          <dt className="font-medium text-card-foreground">
            {sale.tenders !== undefined && sale.tenders.some((tender) => tender.kind !== 'cash')
              ? 'إجمالي المدفوع'
              : 'النقد المستلم'}
          </dt>
          <dd>
            <Numeric value={formatMinor(sale.tenderedMinor ?? sale.cashReceivedMinor)} />
          </dd>
        </div>
        {sale.tenders === undefined || sale.tenders.length === 0 ? null : (
          <div className="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2">
            {sale.tenders.map((tender, index) => (
              <div
                key={`${tender.kind}-${tender.scheme ?? 'cash'}-${String(index)}`}
                className="flex items-center justify-between text-xs text-muted-foreground"
              >
                <dt>{tenderLabel(tender.kind, tender.scheme)}</dt>
                <dd>
                  <Numeric value={formatMinor(tender.amountMinor)} /> ر.س
                </dd>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-baseline justify-between rounded-md bg-accent px-3 py-2.5">
          <dt className="font-semibold text-accent-foreground">الباقي للعميل</dt>
          <dd className="flex items-baseline gap-1">
            <Numeric
              value={formatMinor(sale.changeMinor)}
              className="text-2xl font-bold text-accent-foreground"
            />
            <span className="text-[10px] font-medium text-accent-foreground">ر.س</span>
          </dd>
        </div>
      </dl>

      <Button
        size="lg"
        className="h-touch-lg w-full text-base font-semibold shadow-sm"
        autoFocus
        disabled={receipt === null || printFiscalReceipt === undefined || printState === 'printing'}
        onClick={() => void print()}
      >
        {printLabel}
      </Button>
      <Button
        size="lg"
        className="h-touch-lg w-full text-base font-semibold shadow-sm"
        onClick={onNewSale}
      >
        عملية بيع جديدة
      </Button>
    </CardSurface>
  );
}
