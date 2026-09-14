'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, CardSurface, Numeric } from '@korvi/ui';
import { StatusNote } from '../status-note';
import { formatTimestamp } from '../../lib/datetime';
import { describeFailure } from '../../lib/failures';
import { formatMinor } from '../../lib/money';
import { createMerchantSalesApi } from '../../lib/sales-read-api';
import type { JSX } from 'react';
import type {
  MerchantSaleDetail,
  MerchantSaleStatus,
  MerchantSaleSummary,
  MerchantSalesApi,
  MerchantSalesQuery,
} from '../../lib/sales-read-api';
import type { Failure } from '../../lib/failures';

type ListState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly items: readonly MerchantSaleSummary[];
      readonly nextCursor: string | null;
    }
  | { readonly kind: 'failed'; readonly failure: Failure };

type DetailState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'loading'; readonly saleId: string }
  | { readonly kind: 'ready'; readonly sale: MerchantSaleDetail }
  | { readonly kind: 'failed'; readonly saleId: string; readonly failure: Failure };

function statusLabel(status: MerchantSaleStatus): string {
  return status === 'finalized' ? 'معتمدة' : 'ملغاة';
}

function tenderLabel(kind: string, scheme: string | null): string {
  if (kind === 'cash') return 'نقدي';
  if (kind === 'electronic') return scheme === null ? 'إلكتروني' : `إلكتروني · ${scheme}`;
  return scheme === null ? kind : `${kind} · ${scheme}`;
}

function quantityLabel(quantityScaled: string): string {
  const scaled = BigInt(quantityScaled);
  const sign = scaled < 0n ? '-' : '';
  const magnitude = scaled < 0n ? -scaled : scaled;
  const whole = magnitude / 1000n;
  const fraction = (magnitude % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction === '' ? `${sign}${whole.toString()}` : `${sign}${whole.toString()}.${fraction}`;
}

function toIso(value: string): string | undefined {
  if (value === '') return undefined;
  const parsed = new Date(`${value}:00+03:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function Amount({
  value,
  currency = 'SAR',
}: {
  readonly value: string;
  readonly currency?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 font-medium tabular-nums" dir="ltr">
      <Numeric value={formatMinor(value)} />
      <span className="text-[11px] font-normal text-muted-foreground">{currency}</span>
    </span>
  );
}

function FieldLabel({ children }: { readonly children: React.ReactNode }): JSX.Element {
  return <span className="text-xs font-medium text-muted-foreground">{children}</span>;
}

function SaleDetail({
  state,
  onClose,
  onRetry,
}: {
  readonly state: DetailState;
  readonly onClose: () => void;
  readonly onRetry: (saleId: string) => void;
}): JSX.Element | null {
  if (state.kind === 'closed') return null;

  return (
    <CardSurface className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground">تفاصيل عملية البيع</p>
          <h2 className="mt-1 text-lg font-semibold text-card-foreground">
            {state.kind === 'ready'
              ? (state.sale.invoiceNumber ?? `#${String(state.sale.sequence)}`)
              : 'جاري تحميل الفاتورة'}
          </h2>
        </div>
        <Button type="button" variant="ghost" onClick={onClose}>
          إغلاق
        </Button>
      </div>

      {state.kind === 'loading' ? (
        <p className="p-8 text-center text-sm text-muted-foreground" role="status">
          جارٍ تحميل الحقيقة التاريخية للفواتير…
        </p>
      ) : state.kind === 'failed' ? (
        <div className="flex flex-col gap-3 p-4">
          <StatusNote tone="danger" live>
            {state.failure.message}
          </StatusNote>
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={() => onRetry(state.saleId)}>
              إعادة المحاولة
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-5 p-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <CardSurface className="p-3">
              <FieldLabel>الإجمالي</FieldLabel>
              <div className="mt-1 text-xl">
                <Amount value={state.sale.totalMinor} currency={state.sale.currency} />
              </div>
            </CardSurface>
            <CardSurface className="p-3">
              <FieldLabel>صافي قبل الضريبة</FieldLabel>
              <div className="mt-1 text-xl">
                <Amount value={state.sale.netMinor} currency={state.sale.currency} />
              </div>
            </CardSurface>
            <CardSurface className="p-3">
              <FieldLabel>ضريبة القيمة المضافة</FieldLabel>
              <div className="mt-1 text-xl">
                <Amount value={state.sale.vatMinor} currency={state.sale.currency} />
              </div>
            </CardSurface>
            <CardSurface className="p-3">
              <FieldLabel>الحالة</FieldLabel>
              <div className="mt-2 text-sm font-semibold">{statusLabel(state.sale.status)}</div>
            </CardSurface>
          </div>

          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">التاريخ</dt>
              <dd className="mt-1">{formatTimestamp(state.sale.issuedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">الفرع</dt>
              <dd className="mt-1">{state.sale.branch.nameAr}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">الصندوق</dt>
              <dd className="mt-1">{state.sale.terminal.label}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">الكاشير</dt>
              <dd className="mt-1">{state.sale.cashier.displayName}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">العميل</dt>
              <dd className="mt-1">{state.sale.customer?.nameAr ?? 'بيع مباشر'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">نوع الفاتورة</dt>
              <dd className="mt-1">{state.sale.invoiceType ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">نمط السعر</dt>
              <dd className="mt-1" dir="ltr">
                {state.sale.priceMode}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">رقم العملية</dt>
              <dd className="mt-1 break-all font-mono text-xs" dir="ltr">
                {state.sale.operationId}
              </dd>
            </div>
          </dl>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-semibold">بنود الفاتورة</h3>
              <span className="text-xs text-muted-foreground">{state.sale.lines.length} بند</span>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-start font-medium">الصنف</th>
                    <th className="px-3 py-2 text-start font-medium">SKU</th>
                    <th className="px-3 py-2 text-end font-medium">الكمية</th>
                    <th className="px-3 py-2 text-end font-medium">سعر الوحدة</th>
                    <th className="px-3 py-2 text-end font-medium">الضريبة</th>
                    <th className="px-3 py-2 text-end font-medium">الإجمالي</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {state.sale.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="px-3 py-3 font-medium">{line.nameAr}</td>
                      <td className="px-3 py-3 font-mono text-xs" dir="ltr">
                        {line.sku}
                      </td>
                      <td className="px-3 py-3 text-end font-mono tabular-nums" dir="ltr">
                        {quantityLabel(line.quantityScaled)}
                      </td>
                      <td className="px-3 py-3 text-end">
                        <Amount value={line.unitPriceMinor} currency={state.sale.currency} />
                      </td>
                      <td className="px-3 py-3 text-end font-mono tabular-nums" dir="ltr">
                        {(line.vatBasisPoints / 100).toFixed(2)}%
                      </td>
                      <td className="px-3 py-3 text-end">
                        <Amount value={line.totalMinor} currency={state.sale.currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <div>
              <h3 className="mb-2 font-semibold">التسوية</h3>
              <div className="divide-y divide-border rounded-lg border border-border">
                {state.sale.tenders.map((tender) => (
                  <div
                    key={tender.id}
                    className="flex items-center justify-between gap-4 px-3 py-3 text-sm"
                  >
                    <div>
                      <p className="font-medium">{tenderLabel(tender.kind, tender.scheme)}</p>
                      {tender.reference === null ? null : (
                        <p className="mt-0.5 font-mono text-xs text-muted-foreground" dir="ltr">
                          {tender.reference}
                        </p>
                      )}
                    </div>
                    <Amount value={tender.amountMinor} currency={state.sale.currency} />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="mb-2 font-semibold">المستند الضريبي</h3>
              {state.sale.invoice === null ? (
                <StatusNote tone="warning">لا يوجد مستند ضريبي مرتبط بهذه العملية.</StatusNote>
              ) : (
                <div className="rounded-lg border border-border p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">رقم الفاتورة</span>
                    <strong className="font-mono" dir="ltr">
                      {state.sale.invoice.invoiceNumber}
                    </strong>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">البائع</span>
                    <span>{state.sale.invoice.sellerName}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">الرقم الضريبي</span>
                    <span className="font-mono" dir="ltr">
                      {state.sale.invoice.sellerVatNumber}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </section>

          {state.sale.returns.length === 0 ? null : (
            <section>
              <h3 className="mb-2 font-semibold">المرتجعات المرتبطة</h3>
              <div className="divide-y divide-border rounded-lg border border-border">
                {state.sale.returns.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 text-sm"
                  >
                    <div>
                      <p className="font-medium">{item.returnNumber ?? 'مرتجع'}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {formatTimestamp(item.issuedAt)}
                        {item.reason === null ? '' : ` · ${item.reason}`}
                      </p>
                    </div>
                    <Amount value={item.totalMinor} currency={state.sale.currency} />
                  </div>
                ))}
              </div>
            </section>
          )}

          <p className="text-xs leading-5 text-muted-foreground">
            جميع المبالغ والأسعار والضرائب المعروضة أعلاه هي القيم التاريخية المخزنة وقت اعتماد
            البيع؛ لا تُعاد قراءتها من المنتج الحالي ولا يُعاد احتسابها في المتصفح.
          </p>
        </div>
      )}
    </CardSurface>
  );
}

export function SalesPanel({ api: injected }: { readonly api?: MerchantSalesApi }): JSX.Element {
  const api = useMemo(() => injected ?? createMerchantSalesApi(), [injected]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | MerchantSaleStatus>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [applied, setApplied] = useState<MerchantSalesQuery>({ limit: 50 });
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [detail, setDetail] = useState<DetailState>({ kind: 'closed' });
  const [loadingMore, setLoadingMore] = useState(false);

  const loadList = useCallback(
    async (query: MerchantSalesQuery, signal?: AbortSignal) => {
      const page = await api.list(query, { signal });
      setList({ kind: 'ready', items: page.items, nextCursor: page.nextCursor });
    },
    [api],
  );

  useEffect(() => {
    const controller = new AbortController();
    setList({ kind: 'loading' });
    void loadList(applied, controller.signal).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setList({ kind: 'failed', failure: describeFailure(error) });
    });
    return () => controller.abort();
  }, [applied, loadList]);

  const applyFilters = useCallback(() => {
    setDetail({ kind: 'closed' });
    setApplied({
      limit: 50,
      ...(search.trim() === '' ? {} : { search: search.trim() }),
      ...(status === 'all' ? {} : { status }),
      ...(toIso(from) === undefined ? {} : { from: toIso(from) }),
      ...(toIso(to) === undefined ? {} : { to: toIso(to) }),
    });
  }, [from, search, status, to]);

  const openDetail = useCallback(
    (saleId: string) => {
      const controller = new AbortController();
      setDetail({ kind: 'loading', saleId });
      void api.detail(saleId, { signal: controller.signal }).then(
        (sale) => setDetail({ kind: 'ready', sale }),
        (error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setDetail({ kind: 'failed', saleId, failure: describeFailure(error) });
        },
      );
    },
    [api],
  );

  const loadMore = useCallback(() => {
    if (list.kind !== 'ready' || list.nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    void api.list({ ...applied, cursor: list.nextCursor }).then(
      (page) => {
        setList({
          kind: 'ready',
          items: [...list.items, ...page.items],
          nextCursor: page.nextCursor,
        });
        setLoadingMore(false);
      },
      (error: unknown) => {
        setLoadingMore(false);
        setList({ kind: 'failed', failure: describeFailure(error) });
      },
    );
  }, [api, applied, list, loadingMore]);

  return (
    <div className="flex flex-col gap-4">
      <CardSurface className="p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(220px,1.5fr)_180px_210px_210px_auto] xl:items-end">
          <label className="flex flex-col gap-1.5">
            <FieldLabel>بحث</FieldLabel>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applyFilters();
              }}
              placeholder="رقم الفاتورة، العميل، الكاشير…"
              className="h-touch rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <FieldLabel>الحالة</FieldLabel>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as 'all' | MerchantSaleStatus)}
              className="h-touch rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">الكل</option>
              <option value="finalized">معتمدة</option>
              <option value="voided">ملغاة</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <FieldLabel>من — توقيت الرياض</FieldLabel>
            <input
              type="datetime-local"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="h-touch rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <FieldLabel>إلى — توقيت الرياض</FieldLabel>
            <input
              type="datetime-local"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="h-touch rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <Button type="button" onClick={applyFilters}>
            تطبيق
          </Button>
        </div>
      </CardSurface>

      {list.kind === 'loading' ? (
        <CardSurface className="p-10 text-center text-sm text-muted-foreground" role="status">
          جارٍ تحميل المبيعات…
        </CardSurface>
      ) : list.kind === 'failed' ? (
        <CardSurface className="flex flex-col gap-3 p-4">
          <StatusNote tone="danger" live>
            {list.failure.message}
          </StatusNote>
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={() => setApplied({ ...applied })}>
              إعادة المحاولة
            </Button>
          </div>
        </CardSurface>
      ) : list.items.length === 0 ? (
        <CardSurface className="p-10 text-center">
          <p className="font-medium">لا توجد مبيعات مطابقة</p>
          <p className="mt-1 text-sm text-muted-foreground">غيّر نطاق البحث أو الفترة الزمنية.</p>
        </CardSurface>
      ) : (
        <CardSurface className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-start font-medium">الفاتورة</th>
                  <th className="px-4 py-3 text-start font-medium">التاريخ</th>
                  <th className="px-4 py-3 text-start font-medium">الفرع / الصندوق</th>
                  <th className="px-4 py-3 text-start font-medium">الكاشير</th>
                  <th className="px-4 py-3 text-start font-medium">العميل</th>
                  <th className="px-4 py-3 text-end font-medium">الضريبة</th>
                  <th className="px-4 py-3 text-end font-medium">الإجمالي</th>
                  <th className="px-4 py-3 text-center font-medium">الحالة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {list.items.map((sale) => (
                  <tr key={sale.id} className="transition-colors hover:bg-muted/35">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => openDetail(sale.id)}
                        className="font-mono font-semibold text-primary hover:underline"
                        dir="ltr"
                      >
                        {sale.invoiceNumber ?? `#${String(sale.sequence)}`}
                      </button>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatTimestamp(sale.issuedAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{sale.branch.nameAr}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {sale.terminal.label}
                      </div>
                    </td>
                    <td className="px-4 py-3">{sale.cashier.displayName}</td>
                    <td className="px-4 py-3">{sale.customer?.nameAr ?? 'بيع مباشر'}</td>
                    <td className="px-4 py-3 text-end">
                      <Amount value={sale.vatMinor} currency={sale.currency} />
                    </td>
                    <td className="px-4 py-3 text-end">
                      <Amount value={sale.totalMinor} currency={sale.currency} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
                        {statusLabel(sale.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.nextCursor === null ? null : (
            <div className="flex justify-center border-t border-border p-3">
              <Button type="button" variant="outline" loading={loadingMore} onClick={loadMore}>
                تحميل المزيد
              </Button>
            </div>
          )}
        </CardSurface>
      )}

      <SaleDetail
        state={detail}
        onClose={() => setDetail({ kind: 'closed' })}
        onRetry={openDetail}
      />
    </div>
  );
}
