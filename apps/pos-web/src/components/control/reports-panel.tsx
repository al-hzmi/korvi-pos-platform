'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { StatusNote } from '../status-note';
import { describeFailure } from '../../lib/failures';
import { formatMinor } from '../../lib/money';
import {
  basisPointsLabel,
  createReportsApi,
  nextCivilDate,
  saudiDayStart,
  saudiMonthStart,
  saudiToday,
} from '../../lib/reports-api';
import type { JSX } from 'react';
import type { Failure } from '../../lib/failures';
import type { PeriodReport, ReportTotals, ReportsApi } from '../../lib/reports-api';

interface ReportFilter {
  readonly fromDate: string;
  readonly toDate: string;
  readonly branchId: string;
}

type ReportState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly report: PeriodReport }
  | { readonly kind: 'failed'; readonly failure: Failure };

function initialFilter(): ReportFilter {
  const today = saudiToday();
  return { fromDate: saudiMonthStart(today), toDate: today, branchId: '' };
}

function money(value: string, currency: string): JSX.Element {
  return (
    <span dir="ltr" className="font-mono tabular-nums">
      {formatMinor(value)} {currency}
    </span>
  );
}

function Metric({
  label,
  value,
  currency,
}: {
  readonly label: string;
  readonly value: string;
  readonly currency: string;
}): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold text-foreground">{money(value, currency)}</p>
    </div>
  );
}

function TotalsCard({
  title,
  totals,
  currency,
  tone = 'normal',
}: {
  readonly title: string;
  readonly totals: ReportTotals;
  readonly currency: string;
  readonly tone?: 'normal' | 'return';
}): JSX.Element {
  return (
    <CardSurface className="p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-foreground">{title}</h2>
        <span
          className={`rounded-full px-2 py-1 text-xs font-medium ${
            tone === 'return' ? 'bg-warning/10 text-warning-foreground' : 'bg-muted text-muted-foreground'
          }`}
          dir="ltr"
        >
          {totals.documentCount} مستند
        </span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <Metric label="الصافي قبل الضريبة" value={totals.netMinor} currency={currency} />
        <Metric label="ضريبة القيمة المضافة" value={totals.vatMinor} currency={currency} />
        <Metric label="الإجمالي" value={totals.totalMinor} currency={currency} />
      </div>
    </CardSurface>
  );
}

export interface ReportsPanelProps {
  readonly api?: ReportsApi;
}

export function ReportsPanel({ api: injected }: ReportsPanelProps = {}): JSX.Element {
  const api = useMemo(() => injected ?? createReportsApi(), [injected]);
  const [draft, setDraft] = useState<ReportFilter>(() => initialFilter());
  const [applied, setApplied] = useState<ReportFilter>(() => initialFilter());
  const [state, setState] = useState<ReportState>({ kind: 'loading' });
  const [validation, setValidation] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState({ kind: 'loading' });
      try {
        const report = await api.period(
          {
            from: saudiDayStart(applied.fromDate),
            to: saudiDayStart(nextCivilDate(applied.toDate)),
            ...(applied.branchId === '' ? {} : { branchId: applied.branchId }),
          },
          signal === undefined ? undefined : { signal },
        );
        setState({ kind: 'ready', report });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ kind: 'failed', failure: describeFailure(error) });
      }
    },
    [api, applied],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const branches = state.kind === 'ready' ? state.report.availableBranches : [];

  return (
    <div className="flex flex-col gap-4">
      <CardSurface className="p-4">
        <form
          className="grid gap-3 lg:grid-cols-[1fr_1fr_1.2fr_auto] lg:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.fromDate === '' || draft.toDate === '' || draft.fromDate > draft.toDate) {
              setValidation('تاريخ البداية يجب أن يسبق تاريخ النهاية أو يساويه.');
              return;
            }
            setValidation(null);
            setApplied(draft);
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">من</span>
            <input
              type="date"
              className="h-touch rounded-md border border-input bg-background px-3"
              value={draft.fromDate}
              onChange={(event) => setDraft((value) => ({ ...value, fromDate: event.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">إلى</span>
            <input
              type="date"
              className="h-touch rounded-md border border-input bg-background px-3"
              value={draft.toDate}
              onChange={(event) => setDraft((value) => ({ ...value, toDate: event.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">الفرع</span>
            <select
              className="h-touch rounded-md border border-input bg-background px-3"
              value={draft.branchId}
              onChange={(event) => setDraft((value) => ({ ...value, branchId: event.target.value }))}
            >
              <option value="">كل الفروع</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.nameAr} — {branch.code}{branch.isActive ? '' : ' (غير نشط)'}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit">تطبيق التقرير</Button>
        </form>
        {validation === null ? null : (
          <div className="mt-3">
            <StatusNote tone="warning" live>
              {validation}
            </StatusNote>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          حدود الأيام محسوبة بتوقيت السعودية (+03:00). التقرير يقرأ القيم المالية والضريبية المحفوظة
          وقت إصدار المستند، ولا يعيد تسعير الأصناف أو احتساب ضريبتها من بياناتها الحالية.
        </p>
      </CardSurface>

      {state.kind === 'loading' ? (
        <CardSurface className="p-8 text-center text-sm text-muted-foreground" role="status">
          جارٍ إعداد التقرير من السجلات المالية المعتمدة…
        </CardSurface>
      ) : state.kind === 'failed' ? (
        <CardSurface className="flex flex-col gap-3 p-4">
          <StatusNote tone="danger" live>
            {state.failure.message}
          </StatusNote>
          <div className="flex justify-end">
            <Button variant="outline" onClick={() => void load()}>
              إعادة المحاولة
            </Button>
          </div>
        </CardSurface>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
            <TotalsCard title="المبيعات المعتمدة" totals={state.report.sales} currency={state.report.currency} />
            <TotalsCard
              title="المرتجعات المعتمدة"
              totals={state.report.returns}
              currency={state.report.currency}
              tone="return"
            />
          </div>

          <CardSurface className="p-4">
            <h2 className="font-semibold text-foreground">الصافي بعد المرتجعات</h2>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <Metric
                label="صافي الوعاء"
                value={state.report.netAfterReturns.netMinor}
                currency={state.report.currency}
              />
              <Metric
                label="صافي الضريبة"
                value={state.report.netAfterReturns.vatMinor}
                currency={state.report.currency}
              />
              <Metric
                label="صافي الإجمالي"
                value={state.report.netAfterReturns.totalMinor}
                currency={state.report.currency}
              />
            </div>
          </CardSurface>

          <CardSurface className="overflow-hidden">
            <div className="border-b border-border p-4">
              <h2 className="font-semibold text-foreground">تفصيل ضريبة القيمة المضافة</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                المرتجعات تخصم من نفس فئة الضريبة التاريخية المحفوظة في سطر المستند.
              </p>
            </div>
            {state.report.vatBreakdown.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">
                لا توجد حركة ضريبية معتمدة في الفترة المحددة.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 text-start">النسبة</th>
                      <th className="px-4 py-3 text-start">وعاء المبيعات</th>
                      <th className="px-4 py-3 text-start">ضريبة المبيعات</th>
                      <th className="px-4 py-3 text-start">وعاء المرتجعات</th>
                      <th className="px-4 py-3 text-start">ضريبة المرتجعات</th>
                      <th className="px-4 py-3 text-start">صافي الوعاء</th>
                      <th className="px-4 py-3 text-start">صافي الضريبة</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {state.report.vatBreakdown.map((bucket) => (
                      <tr key={bucket.vatBasisPoints}>
                        <td className="px-4 py-3 font-medium" dir="ltr">
                          {basisPointsLabel(bucket.vatBasisPoints)}
                        </td>
                        <td className="px-4 py-3">{money(bucket.salesNetMinor, state.report.currency)}</td>
                        <td className="px-4 py-3">{money(bucket.salesVatMinor, state.report.currency)}</td>
                        <td className="px-4 py-3">{money(bucket.returnsNetMinor, state.report.currency)}</td>
                        <td className="px-4 py-3">{money(bucket.returnsVatMinor, state.report.currency)}</td>
                        <td className="px-4 py-3">{money(bucket.netTaxableMinor, state.report.currency)}</td>
                        <td className="px-4 py-3">{money(bucket.netVatMinor, state.report.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardSurface>

          <CardSurface className="overflow-hidden">
            <div className="border-b border-border p-4">
              <h2 className="font-semibold text-foreground">التفصيل حسب الفرع</h2>
            </div>
            {state.report.branchBreakdown.length === 0 ? (
              <p className="p-6 text-center text-sm text-muted-foreground">لا توجد فروع ضمن التقرير.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px] text-sm">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 text-start">الفرع</th>
                      <th className="px-4 py-3 text-start">فواتير البيع</th>
                      <th className="px-4 py-3 text-start">إجمالي المبيعات</th>
                      <th className="px-4 py-3 text-start">المرتجعات</th>
                      <th className="px-4 py-3 text-start">إجمالي المرتجعات</th>
                      <th className="px-4 py-3 text-start">الصافي</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {state.report.branchBreakdown.map((branch) => (
                      <tr key={branch.id}>
                        <td className="px-4 py-3">
                          <span className="font-medium text-foreground">{branch.nameAr}</span>
                          <span className="ms-2 text-xs text-muted-foreground" dir="ltr">
                            {branch.code}
                          </span>
                        </td>
                        <td className="px-4 py-3" dir="ltr">{branch.sales.documentCount}</td>
                        <td className="px-4 py-3">{money(branch.sales.totalMinor, state.report.currency)}</td>
                        <td className="px-4 py-3" dir="ltr">{branch.returns.documentCount}</td>
                        <td className="px-4 py-3">{money(branch.returns.totalMinor, state.report.currency)}</td>
                        <td className="px-4 py-3 font-medium">
                          {money(branch.netAfterReturns.totalMinor, state.report.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardSurface>
        </>
      )}
    </div>
  );
}
