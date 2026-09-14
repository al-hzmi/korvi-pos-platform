'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { StatusNote } from '../status-note';
import { describeFailure } from '../../lib/failures';
import { createZatcaApi } from '../../lib/zatca-api';
import type { JSX } from 'react';
import type { Failure } from '../../lib/failures';
import type {
  ZatcaApi,
  ZatcaEnvironment,
  ZatcaProvisioningState,
  ZatcaStatus,
  ZatcaSubmissionMode,
  ZatcaSubmissionState,
  ZatcaUncertaintyReason,
} from '../../lib/zatca-api';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly status: ZatcaStatus }
  | { readonly kind: 'failed'; readonly failure: Failure };

const PROVISIONING_LABEL: Readonly<Record<ZatcaProvisioningState, string>> = {
  prepared: 'مجهز للإرسال',
  'in-flight': 'طلب الربط جارٍ',
  issued: 'صدر الاعتماد',
  rejected: 'مرفوض',
  uncertain: 'النتيجة غير مؤكدة',
};

const SUBMISSION_LABEL: Readonly<Record<ZatcaSubmissionState, string>> = {
  pending: 'بانتظار الإرسال',
  'in-flight': 'جارٍ الإرسال',
  accepted: 'مقبول',
  rejected: 'مرفوض',
  uncertain: 'النتيجة غير مؤكدة',
};

const ENVIRONMENT_LABEL: Readonly<Record<ZatcaEnvironment, string>> = {
  sandbox: 'بيئة الاختبار',
  simulation: 'بيئة المحاكاة',
  production: 'بيئة الإنتاج',
};

const MODE_LABEL: Readonly<Record<ZatcaSubmissionMode, string>> = {
  reporting: 'إبلاغ',
  clearance: 'تخليص',
};

const UNCERTAINTY_LABEL: Readonly<Record<ZatcaUncertaintyReason, string>> = {
  'credential-store': 'تعذر حسم حالة بيانات الاعتماد',
  transport: 'انقطع الاتصال بعد احتمال إرسال الطلب',
  'response-invalid': 'وصل رد غير صالح للتحقق',
};

function dateTime(value: string | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat('ar-SA', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Riyadh',
  }).format(date);
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function Metric({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-foreground" dir="ltr">
        {value}
      </p>
    </div>
  );
}

export interface ZatcaPanelProps {
  readonly api?: ZatcaApi;
}

/** Read-only merchant projection of durable ZATCA state. No credential material reaches this UI. */
export function ZatcaPanel({ api: injected }: ZatcaPanelProps = {}): JSX.Element {
  const api = useMemo(() => injected ?? createZatcaApi(), [injected]);
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState({ kind: 'loading' });
      try {
        const status = await api.status(signal === undefined ? undefined : { signal });
        setState({ kind: 'ready', status });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ kind: 'failed', failure: describeFailure(error) });
      }
    },
    [api],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (state.kind === 'loading') {
    return (
      <CardSurface className="p-8 text-center text-sm text-muted-foreground" role="status">
        جارٍ قراءة حالة الربط والإرسال من سجلات ZATCA المعتمدة…
      </CardSurface>
    );
  }

  if (state.kind === 'failed') {
    return (
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
    );
  }

  const status = state.status;
  return (
    <div className="flex flex-col gap-4">
      <CardSurface className="p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="font-semibold text-foreground">حالة التكامل مع هيئة الزكاة والضريبة والجمارك</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              الحالة أدناه مشتقة من محاولات الربط وأدلة الامتثال ونتائج إرسال الفواتير المحفوظة في النظام.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            تحديث الحالة
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          لأسباب أمنية لا تعرض لوحة التاجر مفاتيح التوقيع أو الأسرار أو الشهادات أو XML الفواتير.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          <Metric label="أجهزة نقاط البيع" value={status.summary.terminalCount} />
          <Metric label="أجهزة اجتازت الامتثال" value={status.summary.complianceReadyTerminalCount} />
          <Metric label="إرسالات مقبولة" value={status.summary.acceptedSubmissionCount} />
          <Metric label="إرسالات غير محسومة" value={status.summary.unresolvedSubmissionCount} />
          <Metric label="إرسالات مرفوضة" value={status.summary.rejectedSubmissionCount} />
        </div>
      </CardSurface>

      <CardSurface className="overflow-hidden">
        <div className="border-b border-border p-4">
          <h2 className="font-semibold text-foreground">حالة الأجهزة والربط</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            قبول الامتثال دليل محفوظ لعملية الامتثال، ولا يُقدَّم هنا على أنه فحص آني لصلاحية الشهادة.
          </p>
        </div>
        {status.terminals.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">لا توجد أجهزة مسجلة للمنشأة.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-muted/60 text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-start">الجهاز</th>
                  <th className="px-4 py-3 text-start">الحالة</th>
                  <th className="px-4 py-3 text-start">البيئة</th>
                  <th className="px-4 py-3 text-start">آخر ربط</th>
                  <th className="px-4 py-3 text-start">قبول الامتثال</th>
                  <th className="px-4 py-3 text-start">آخر ظهور</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {status.terminals.map((terminal) => {
                  const provisioning = terminal.latestProvisioning;
                  return (
                    <tr key={terminal.terminalId}>
                      <td className="px-4 py-3">
                        <span className="font-medium text-foreground">{terminal.label}</span>
                        <span className="ms-2 text-xs text-muted-foreground" dir="ltr">
                          {terminal.code}
                        </span>
                        {!terminal.isActive ? (
                          <span className="ms-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            غير نشط
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        {provisioning === null ? 'لم يبدأ الربط' : PROVISIONING_LABEL[provisioning.state]}
                        {provisioning?.rejectionCode === null || provisioning?.rejectionCode === undefined ? null : (
                          <div className="mt-1 text-xs text-destructive" dir="ltr">
                            {provisioning.rejectionCode}
                          </div>
                        )}
                        {provisioning?.uncertaintyReason === null ||
                        provisioning?.uncertaintyReason === undefined ? null : (
                          <div className="mt-1 text-xs text-warning-foreground">
                            {UNCERTAINTY_LABEL[provisioning.uncertaintyReason]}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {provisioning === null ? '—' : ENVIRONMENT_LABEL[provisioning.environment]}
                      </td>
                      <td className="px-4 py-3" dir="ltr">
                        {provisioning === null ? '—' : dateTime(provisioning.resolvedAt ?? provisioning.preparedAt)}
                      </td>
                      <td className="px-4 py-3" dir="ltr">
                        {dateTime(terminal.complianceAcceptedAt)}
                      </td>
                      <td className="px-4 py-3" dir="ltr">
                        {dateTime(terminal.lastSeenAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {status.terminalHasMore ? (
          <div className="border-t border-border p-3">
            <StatusNote tone="warning">
              توجد أجهزة إضافية خارج حد العرض الحالي. إجماليات المنشأة أعلاه تشملها جميعًا.
            </StatusNote>
          </div>
        ) : null}
      </CardSurface>

      <CardSurface className="overflow-hidden">
        <div className="border-b border-border p-4">
          <h2 className="font-semibold text-foreground">أحدث إرسالات الفواتير</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            تعرض آخر 25 عملية كما حُفظت في آلة الحالات الدائمة؛ الحالة غير المؤكدة لا تُحوَّل إلى نجاح أو فشل بالتخمين.
          </p>
        </div>
        {status.recentSubmissions.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">لا توجد إرسالات ZATCA محفوظة بعد.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-muted/60 text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-start">الفاتورة</th>
                  <th className="px-4 py-3 text-start">النوع</th>
                  <th className="px-4 py-3 text-start">البيئة</th>
                  <th className="px-4 py-3 text-start">الحالة</th>
                  <th className="px-4 py-3 text-start">حالة الهيئة</th>
                  <th className="px-4 py-3 text-start">HTTP</th>
                  <th className="px-4 py-3 text-start">وقت الحسم</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {status.recentSubmissions.map((submission) => (
                  <tr key={submission.submissionId}>
                    <td className="px-4 py-3 font-mono text-xs" dir="ltr" title={submission.invoiceId}>
                      {shortId(submission.invoiceId)}
                    </td>
                    <td className="px-4 py-3">{MODE_LABEL[submission.mode]}</td>
                    <td className="px-4 py-3">{ENVIRONMENT_LABEL[submission.environment]}</td>
                    <td className="px-4 py-3">
                      {SUBMISSION_LABEL[submission.state]}
                      {submission.rejectionCode === null ? null : (
                        <div className="mt-1 text-xs text-destructive" dir="ltr">
                          {submission.rejectionCode}
                        </div>
                      )}
                      {submission.uncertaintyReason === null ? null : (
                        <div className="mt-1 text-xs text-warning-foreground">
                          {UNCERTAINTY_LABEL[submission.uncertaintyReason]}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3" dir="ltr">
                      {submission.authorityStatus ?? '—'}
                    </td>
                    <td className="px-4 py-3" dir="ltr">
                      {submission.httpStatus ?? '—'}
                    </td>
                    <td className="px-4 py-3" dir="ltr">
                      {dateTime(submission.resolvedAt ?? submission.requestStartedAt ?? submission.queuedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardSurface>
    </div>
  );
}
