'use client';

import { BidiIsolate, Button, CardSurface, Numeric } from '@korvi/ui';
import { formatMinor } from '../lib/money';
import { formatScaled } from '../lib/quantity';
import { formatTimestamp } from '../lib/datetime';
import type { JSX } from 'react';
import type { SaleSummary } from '../lib/api-types';

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
  readonly replayed: boolean;
  readonly onNewSale: () => void;
}

export function SaleReceipt({ sale, replayed, onNewSale }: SaleReceiptProps): JSX.Element {
  return (
    <CardSurface className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="inline-flex w-fit items-center rounded-md bg-success/10 px-2 py-1 text-xs font-semibold text-success ring-1 ring-inset ring-success/30">
            {replayed ? 'عملية مسجّلة مسبقاً' : 'تمّت العملية'}
          </span>
          <h2 className="text-lg font-semibold text-card-foreground">
            فاتورة <BidiIsolate>{sale.invoiceNumber}</BidiIsolate>
          </h2>
          <p className="text-xs text-muted-foreground">
            الكاشير {sale.cashierName} · <BidiIsolate>{formatTimestamp(sale.issuedAt)}</BidiIsolate>
          </p>
        </div>
        <Numeric
          value={formatMinor(sale.totalMinor)}
          className="text-3xl font-bold text-foreground"
        />
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto border-y border-border">
        {sale.lines.map((line) => (
          <li
            key={line.lineNumber}
            className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm text-card-foreground">{line.nameAr}</span>
              <span className="text-xs text-muted-foreground">
                <Numeric value={formatScaled(line.quantityScaled)} />
                {' × '}
                <Numeric value={formatMinor(line.unitPriceMinor)} />
              </span>
            </span>
            <Numeric value={formatMinor(line.totalMinor)} className="text-sm font-medium" />
          </li>
        ))}
      </ul>

      <dl className="flex flex-col gap-1 text-sm">
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
        <div className="flex items-center justify-between">
          <dt className="text-card-foreground">النقد المستلم</dt>
          <dd>
            <Numeric value={formatMinor(sale.cashReceivedMinor)} />
          </dd>
        </div>
        <div className="flex items-baseline justify-between rounded-md bg-accent px-3 py-2">
          <dt className="font-semibold text-accent-foreground">الباقي للعميل</dt>
          <dd>
            <Numeric
              value={formatMinor(sale.changeMinor)}
              className="text-2xl font-bold text-accent-foreground"
            />
          </dd>
        </div>
      </dl>

      <Button size="lg" className="w-full" autoFocus onClick={onNewSale}>
        عملية بيع جديدة
      </Button>
    </CardSurface>
  );
}
