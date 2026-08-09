'use client';

import { useEffect, useState } from 'react';
import { CardSurface, Numeric } from '@korvi/ui';
import { StatusNote } from '../status-note';
import { formatMinor } from '../../lib/money';
import { formatTimestamp } from '../../lib/datetime';
import { describeFailure } from '../../lib/failures';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type { DashboardSummary } from '../../lib/api-types';
import type { Failure } from '../../lib/failures';

/**
 * Real numbers or none.
 *
 * Every figure is one the server counted from rows a merchant can go and look
 * at. There is no placeholder state that renders zeros while loading, because
 * a zero that means "not yet" is indistinguishable from a zero that means "no
 * sales", and only one of those is worth showing an owner.
 */
type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly summary: DashboardSummary }
  | { readonly kind: 'failed'; readonly failure: Failure };

function Figure({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: JSX.Element;
  readonly hint?: string;
}): JSX.Element {
  return (
    <CardSurface className="flex flex-col gap-1 p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold text-card-foreground">{value}</span>
      {hint === undefined ? null : <span className="text-xs text-muted-foreground">{hint}</span>}
    </CardSurface>
  );
}

export function DashboardPanel({ api }: { readonly api: ApiClient }): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    void api
      .dashboardSummary({ signal: controller.signal })
      .then((summary) => {
        if (live) setState({ kind: 'ready', summary });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (live) setState({ kind: 'failed', failure: describeFailure(error) });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [api]);

  if (state.kind === 'loading') {
    return (
      <p
        className="py-10 text-center text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        جارٍ تحميل المؤشرات…
      </p>
    );
  }

  if (state.kind === 'failed') {
    return (
      <StatusNote tone={state.failure.action === 'permission' ? 'warning' : 'danger'} live>
        {state.failure.message}
      </StatusNote>
    );
  }

  const summary = state.summary;
  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Figure
          label="مبيعات آخر ٢٤ ساعة"
          value={<Numeric value={formatMinor(summary.grossSalesLast24HoursMinor)} />}
          hint={`${summary.currency} · منذ ${formatTimestamp(summary.since)}`}
        />
        <Figure
          label="ضريبة القيمة المضافة (٢٤ ساعة)"
          value={<Numeric value={formatMinor(summary.vatLast24HoursMinor)} />}
          hint={summary.currency}
        />
        <Figure
          label="عدد الفواتير (٢٤ ساعة)"
          value={<Numeric value={String(summary.salesLast24HoursCount)} />}
        />
        <Figure
          label="الأصناف المفعّلة"
          value={<Numeric value={String(summary.activeProductCount)} />}
        />
        <Figure label="الصناديق" value={<Numeric value={String(summary.terminalCount)} />} />
        <Figure
          label="الورديات المفتوحة"
          value={<Numeric value={String(summary.openShiftCount)} />}
        />
      </section>

      <p className="text-xs text-muted-foreground">
        نافذة متحركة مدتها ٢٤ ساعة، لا يوم تقويمي — لأن المنطقة الزمنية للمنشأة ليست محفوظة بعد.
        تُحتسب الفواتير المعتمدة فقط.
      </p>
    </div>
  );
}
