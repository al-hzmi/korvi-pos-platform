'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button, CardSurface, KorviMark } from '@korvi/ui';
import { ApiError } from '../../lib/api';
import {
  createPlatformApi,
  type PlatformAuditPage,
  type PlatformCommercialState,
  type PlatformEntitlement,
  type PlatformSession,
  type PlatformTenantDetail,
} from '../../lib/platform-api';
import {
  PLATFORM_INPUT,
  PLATFORM_LABEL,
  PlatformEmpty,
  PlatformMetric,
  PlatformNotice,
  PlatformPageHeader,
  PlatformSkeletonRows,
  PlatformStatusBadge,
} from './platform-ui';
import type { FormEvent, JSX } from 'react';

const api = createPlatformApi();

type PageState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'signed-out'; readonly unavailable: boolean }
  | { readonly kind: 'loading'; readonly session: PlatformSession }
  | {
      readonly kind: 'ready';
      readonly session: PlatformSession;
      readonly detail: PlatformTenantDetail;
      readonly audit: PlatformAuditPage;
    }
  | { readonly kind: 'failed'; readonly session: PlatformSession; readonly message: string };

interface EntitlementDraft {
  readonly rowId: string;
  readonly key: string;
  readonly kind: 'flag' | 'limit';
  readonly value: string;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0)
      return 'لم يصل تأكيد من الخادم. لم يُغيَّر رقم العملية ويمكن إعادة المحاولة بأمان.';
    if (error.status === 401) return 'انتهت جلسة إدارة المنصة.';
    if (error.status === 403) return 'لا تملك الجلسة الصلاحية المطلوبة.';
    if (error.status === 404) return 'المنشأة غير موجودة أو لم تعد متاحة.';
    if (error.status === 409)
      return 'تعارض الطلب مع الحالة الحالية. حدّث الصفحة قبل إعادة المحاولة.';
    return error.serverMessage ?? 'تعذّر تنفيذ العملية.';
  }
  return 'حدث خطأ غير متوقع أثناء تنفيذ العملية.';
}

function LoginGate({
  unavailable,
  onSignedIn,
}: {
  readonly unavailable: boolean;
  readonly onSignedIn: (session: PlatformSession) => void;
}): JSX.Element {
  const [accessKey, setAccessKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || accessKey === '') return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(accessKey);
      setAccessKey('');
      onSignedIn(session);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/20 px-4">
      <CardSurface className="w-full max-w-md p-6 sm:p-8">
        <KorviMark size="md" suffix="PLATFORM" />
        <h1 className="mt-6 text-xl font-semibold text-card-foreground">استعادة جلسة المنصة</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          سجّل الدخول للعودة إلى سجل المنشأة. لا يتم تخزين مفتاح الوصول في التطبيق.
        </p>
        <form className="mt-6 space-y-4" onSubmit={submit}>
          <div>
            <label className={PLATFORM_LABEL} htmlFor="platform-detail-key">
              مفتاح الوصول
            </label>
            <input
              id="platform-detail-key"
              className={PLATFORM_INPUT}
              type="password"
              value={accessKey}
              onChange={(event) => setAccessKey(event.target.value)}
              disabled={busy || unavailable}
            />
          </div>
          {unavailable ? (
            <PlatformNotice tone="warning">إدارة المنصة غير مفعّلة على هذا النشر.</PlatformNotice>
          ) : null}
          {error === null ? null : <PlatformNotice tone="danger">{error}</PlatformNotice>}
          <Button
            className="w-full"
            type="submit"
            loading={busy}
            disabled={unavailable || accessKey === ''}
          >
            دخول
          </Button>
        </form>
      </CardSurface>
    </main>
  );
}

function LifecycleActions({
  detail,
  onChanged,
}: {
  readonly detail: PlatformTenantDetail;
  readonly onChanged: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suspensionOpen, setSuspensionOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pendingOperationId, setPendingOperationId] = useState<string | null>(null);

  const run = async (kind: 'activate' | 'reactivate' | 'suspend') => {
    if (busy) return;
    const operationId = pendingOperationId ?? crypto.randomUUID();
    setPendingOperationId(operationId);
    setBusy(true);
    setError(null);
    try {
      if (kind === 'activate') await api.activateTenant(detail.tenant.id, operationId);
      if (kind === 'reactivate') await api.reactivateTenant(detail.tenant.id, operationId);
      if (kind === 'suspend') await api.suspendTenant(detail.tenant.id, operationId, reason.trim());
      setPendingOperationId(null);
      setSuspensionOpen(false);
      setReason('');
      onChanged();
    } catch (caught) {
      setError(messageFor(caught));
      if (!(caught instanceof ApiError) || !caught.ambiguous) setPendingOperationId(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <CardSurface className="p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-card-foreground">دورة الحياة التشغيلية</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            الإيقاف يلغي الجلسات النشطة داخل المنشأة في نفس المعاملة.
          </p>
        </div>
        <PlatformStatusBadge status={detail.tenant.status} />
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {detail.tenant.status === 'provisioning' ? (
          <Button loading={busy} onClick={() => void run('activate')}>
            تفعيل المنشأة
          </Button>
        ) : null}
        {detail.tenant.status === 'active' ? (
          <Button variant="destructive" disabled={busy} onClick={() => setSuspensionOpen(true)}>
            إيقاف المنشأة
          </Button>
        ) : null}
        {detail.tenant.status === 'suspended' ? (
          <Button loading={busy} onClick={() => void run('reactivate')}>
            إعادة التفعيل
          </Button>
        ) : null}
      </div>

      {suspensionOpen ? (
        <div className="mt-5 rounded-lg border border-destructive/20 bg-destructive/5 p-4">
          <label className={PLATFORM_LABEL} htmlFor="platform-suspension-reason">
            سبب الإيقاف
          </label>
          <textarea
            id="platform-suspension-reason"
            className={`${PLATFORM_INPUT} min-h-24 resize-y py-3`}
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="اكتب سببًا واضحًا سيبقى ضمن سجل التدقيق"
          />
          <div className="mt-3 flex gap-2">
            <Button
              variant="destructive"
              loading={busy}
              disabled={reason.trim() === ''}
              onClick={() => void run('suspend')}
            >
              تأكيد الإيقاف
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setSuspensionOpen(false)}>
              إلغاء
            </Button>
          </div>
        </div>
      ) : null}
      {error === null ? null : (
        <div className="mt-4">
          <PlatformNotice tone="danger">{error}</PlatformNotice>
        </div>
      )}
    </CardSurface>
  );
}

function CommercialPanel({
  detail,
  onChanged,
}: {
  readonly detail: PlatformTenantDetail;
  readonly onChanged: () => void;
}): JSX.Element {
  const current = detail.commercial;
  const [editing, setEditing] = useState(false);
  const [planKey, setPlanKey] = useState(current?.planKey ?? '');
  const [revision, setRevision] = useState(String(current?.planRevision ?? 1));
  const [accountState, setAccountState] = useState<PlatformCommercialState>(
    current?.state ?? 'active',
  );
  const [rows, setRows] = useState<readonly EntitlementDraft[]>(() =>
    (current?.entitlements ?? []).map((grant) => ({
      rowId: crypto.randomUUID(),
      key: grant.key,
      kind: grant.kind,
      value: grant.kind === 'flag' ? String(grant.enabled) : grant.limit,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingOperationId, setPendingOperationId] = useState<string | null>(null);

  const addEntitlement = () => {
    setRows((value) => [
      ...value,
      { rowId: crypto.randomUUID(), key: '', kind: 'flag', value: 'true' },
    ]);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const parsedRevision = Number(revision);
    if (!Number.isSafeInteger(parsedRevision) || parsedRevision < 1) {
      setError('إصدار الخطة يجب أن يكون عددًا صحيحًا موجبًا.');
      return;
    }
    const entitlements: PlatformEntitlement[] = [];
    for (const row of rows) {
      const key = row.key.trim();
      if (key === '') {
        setError('كل صلاحية تجارية تحتاج مفتاحًا واضحًا.');
        return;
      }
      if (row.kind === 'flag') {
        entitlements.push({ key, kind: 'flag', enabled: row.value === 'true' });
      } else {
        if (!/^\d{1,19}$/.test(row.value)) {
          setError(`الحد الخاص بـ ${key} يجب أن يكون عددًا صحيحًا غير سالب.`);
          return;
        }
        entitlements.push({ key, kind: 'limit', limit: row.value });
      }
    }

    const operationId = pendingOperationId ?? crypto.randomUUID();
    setPendingOperationId(operationId);
    setBusy(true);
    setError(null);
    try {
      await api.assignPlan(detail.tenant.id, {
        operationId,
        planKey: planKey.trim(),
        planRevision: parsedRevision,
        accountState,
        entitlements,
      });
      setPendingOperationId(null);
      setEditing(false);
      onChanged();
    } catch (caught) {
      setError(messageFor(caught));
      if (!(caught instanceof ApiError) || !caught.ambiguous) setPendingOperationId(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <CardSurface className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-card-foreground">الحساب التجاري</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            الخطة والصلاحيات التجارية منفصلة عن حالة تشغيل المنشأة.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing((value) => !value)}>
          {editing ? 'إغلاق التحرير' : current === null ? 'تعيين خطة' : 'تحديث الخطة'}
        </Button>
      </div>

      {!editing ? (
        current === null ? (
          <div className="mt-5">
            <PlatformEmpty
              title="لا توجد خطة معيّنة"
              description="الحساب التجاري غير مهيأ، لذلك أي صلاحية تعتمد على الاشتراك تفشل مغلقة."
            />
          </div>
        ) : (
          <div className="mt-5 space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">الخطة</p>
                <p className="mt-1 font-mono text-sm font-semibold" dir="ltr">
                  {current.planKey}
                </p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">الإصدار</p>
                <p className="mt-1 font-mono text-sm font-semibold" dir="ltr">
                  {current.planRevision}
                </p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">الحالة التجارية</p>
                <p className="mt-1 text-sm font-semibold">
                  {current.state === 'active' ? 'نشطة' : 'مقيّدة'}
                </p>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">الصلاحيات التجارية</p>
              {current.entitlements.length === 0 ? (
                <p className="text-sm text-muted-foreground">لا توجد صلاحيات في هذا التعيين.</p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                  {current.entitlements.map((grant) => (
                    <div
                      key={grant.key}
                      className="flex min-h-11 items-center justify-between gap-3 border-b border-border/70 px-3 py-2 last:border-b-0"
                    >
                      <span className="font-mono text-xs" dir="ltr">
                        {grant.key}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {grant.kind === 'flag'
                          ? grant.enabled
                            ? 'مفعّلة'
                            : 'معطّلة'
                          : `الحد: ${grant.limit}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      ) : (
        <form className="mt-5 space-y-5" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className={PLATFORM_LABEL} htmlFor="plan-key">
                مفتاح الخطة
              </label>
              <input
                id="plan-key"
                className={PLATFORM_INPUT}
                dir="ltr"
                value={planKey}
                onChange={(event) => setPlanKey(event.target.value)}
                required
              />
            </div>
            <div>
              <label className={PLATFORM_LABEL} htmlFor="plan-revision">
                الإصدار
              </label>
              <input
                id="plan-revision"
                className={PLATFORM_INPUT}
                dir="ltr"
                inputMode="numeric"
                value={revision}
                onChange={(event) => setRevision(event.target.value)}
                required
              />
            </div>
            <div>
              <label className={PLATFORM_LABEL} htmlFor="plan-state">
                الحالة التجارية
              </label>
              <select
                id="plan-state"
                className={PLATFORM_INPUT}
                value={accountState}
                onChange={(event) => setAccountState(event.target.value as PlatformCommercialState)}
              >
                <option value="active">نشطة</option>
                <option value="restricted">مقيّدة</option>
              </select>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-muted-foreground">الصلاحيات والحدود</p>
              <Button type="button" variant="ghost" size="sm" onClick={addEntitlement}>
                إضافة صلاحية
              </Button>
            </div>
            <div className="space-y-2">
              {rows.map((row) => (
                <div
                  key={row.rowId}
                  className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_120px_1fr_auto] sm:items-end"
                >
                  <div>
                    <label className={PLATFORM_LABEL}>المفتاح</label>
                    <input
                      className={PLATFORM_INPUT}
                      dir="ltr"
                      value={row.key}
                      onChange={(event) =>
                        setRows((all) =>
                          all.map((item) =>
                            item.rowId === row.rowId ? { ...item, key: event.target.value } : item,
                          ),
                        )
                      }
                    />
                  </div>
                  <div>
                    <label className={PLATFORM_LABEL}>النوع</label>
                    <select
                      className={PLATFORM_INPUT}
                      value={row.kind}
                      onChange={(event) =>
                        setRows((all) =>
                          all.map((item) =>
                            item.rowId === row.rowId
                              ? {
                                  ...item,
                                  kind: event.target.value as 'flag' | 'limit',
                                  value: event.target.value === 'flag' ? 'true' : '0',
                                }
                              : item,
                          ),
                        )
                      }
                    >
                      <option value="flag">تشغيل</option>
                      <option value="limit">حد</option>
                    </select>
                  </div>
                  <div>
                    <label className={PLATFORM_LABEL}>
                      {row.kind === 'flag' ? 'القيمة' : 'الحد'}
                    </label>
                    {row.kind === 'flag' ? (
                      <select
                        className={PLATFORM_INPUT}
                        value={row.value}
                        onChange={(event) =>
                          setRows((all) =>
                            all.map((item) =>
                              item.rowId === row.rowId
                                ? { ...item, value: event.target.value }
                                : item,
                            ),
                          )
                        }
                      >
                        <option value="true">مفعّلة</option>
                        <option value="false">معطّلة</option>
                      </select>
                    ) : (
                      <input
                        className={PLATFORM_INPUT}
                        dir="ltr"
                        inputMode="numeric"
                        value={row.value}
                        onChange={(event) =>
                          setRows((all) =>
                            all.map((item) =>
                              item.rowId === row.rowId
                                ? { ...item, value: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRows((all) => all.filter((item) => item.rowId !== row.rowId))}
                  >
                    حذف
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {error === null ? null : <PlatformNotice tone="danger">{error}</PlatformNotice>}
          <div className="flex justify-end">
            <Button type="submit" loading={busy} disabled={planKey.trim() === ''}>
              حفظ التعيين
            </Button>
          </div>
        </form>
      )}
    </CardSurface>
  );
}

function AuditPanel({ audit }: { readonly audit: PlatformAuditPage }): JSX.Element {
  return (
    <CardSurface className="overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <p className="text-sm font-semibold text-card-foreground">سجل التدقيق</p>
        <p className="mt-1 text-xs text-muted-foreground">
          أحدث الأحداث المحفوظة داخل نطاق المنشأة.
        </p>
      </div>
      {audit.items.length === 0 ? (
        <div className="p-5 text-sm text-muted-foreground">لا توجد أحداث مسجلة.</div>
      ) : (
        <div>
          {audit.items.map((entry) => (
            <div
              key={entry.id}
              className="grid gap-2 border-b border-border/70 px-5 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-xs font-medium" dir="ltr">
                  {entry.eventType}
                </p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {entry.entityType}
                  {entry.entityId === null ? '' : ` · ${entry.entityId}`}
                </p>
              </div>
              <time
                className="text-xs text-muted-foreground sm:text-start"
                dateTime={entry.occurredAt}
              >
                {new Intl.DateTimeFormat('ar-SA', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(entry.occurredAt))}
              </time>
            </div>
          ))}
        </div>
      )}
    </CardSurface>
  );
}

function DetailView({
  session,
  detail,
  audit,
  onRefresh,
  onSignedOut,
}: {
  readonly session: PlatformSession;
  readonly detail: PlatformTenantDetail;
  readonly audit: PlatformAuditPage;
  readonly onRefresh: () => void;
  readonly onSignedOut: () => void;
}): JSX.Element {
  const canManageTenant = session.permissions.includes('platform.tenants.manage');
  const canManageCommercial = session.permissions.includes('platform.commercial.manage');
  const lastActivity = detail.operations.lastActivityAt;

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1500px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-4">
            <KorviMark size="sm" suffix="PLATFORM" />
            <span className="hidden h-5 w-px bg-border sm:block" />
            <Link
              className="text-sm font-medium text-muted-foreground hover:text-foreground"
              href="/platform"
            >
              المنشآت
            </Link>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void api.logout().finally(onSignedOut)}>
            تسجيل الخروج
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <PlatformPageHeader
          eyebrow={detail.tenant.slug}
          title={detail.tenant.name}
          description="السجل التشغيلي والتجاري للمنشأة كما هو محفوظ في سلطة المنصة وقاعدة بيانات التاجر."
          action={<PlatformStatusBadge status={detail.tenant.status} />}
        />

        <section className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <PlatformMetric
            label="الفروع"
            value={`${detail.operations.branches.active}/${detail.operations.branches.total}`}
            detail="نشط / إجمالي"
          />
          <PlatformMetric
            label="الصناديق"
            value={`${detail.operations.terminals.active}/${detail.operations.terminals.total}`}
            detail="نشط / إجمالي"
          />
          <PlatformMetric
            label="المستخدمون"
            value={`${detail.operations.users.active}/${detail.operations.users.total}`}
            detail="نشط / إجمالي"
          />
          <PlatformMetric
            label="آخر نشاط"
            value={
              lastActivity === null
                ? '—'
                : new Intl.DateTimeFormat('ar-SA', { dateStyle: 'short' }).format(
                    new Date(lastActivity),
                  )
            }
          />
        </section>

        <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.8fr)]">
          <div className="space-y-5">
            {canManageTenant ? <LifecycleActions detail={detail} onChanged={onRefresh} /> : null}
            {canManageCommercial ? <CommercialPanel detail={detail} onChanged={onRefresh} /> : null}
            {session.permissions.includes('platform.audit.read') ? (
              <AuditPanel audit={audit} />
            ) : null}
          </div>

          <aside className="space-y-5">
            <CardSurface className="p-5">
              <p className="text-sm font-semibold text-card-foreground">هوية المنشأة</p>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">المعرّف</dt>
                  <dd className="font-mono text-xs" dir="ltr">
                    {detail.tenant.slug}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">الرقم الضريبي</dt>
                  <dd className="font-mono text-xs" dir="ltr">
                    {detail.tenant.vatNumber ?? '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">تاريخ الإنشاء</dt>
                  <dd>
                    {new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium' }).format(
                      new Date(detail.tenant.createdAt),
                    )}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">مصدر الحالة</dt>
                  <dd className="max-w-[180px] truncate text-start font-mono text-xs" dir="ltr">
                    {detail.tenant.lifecycleProvenance}
                  </dd>
                </div>
              </dl>
            </CardSurface>

            <CardSurface className="p-5">
              <p className="text-sm font-semibold text-card-foreground">المالك</p>
              {detail.operations.owner === null ? (
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  لم يُثبت مالك للمنشأة بعد.
                </p>
              ) : (
                <div className="mt-3">
                  <p className="text-sm font-medium">{detail.operations.owner.displayName}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground" dir="ltr">
                    {detail.operations.owner.email}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {detail.operations.owner.isActive ? 'حساب نشط' : 'حساب معطّل'}
                  </p>
                </div>
              )}
            </CardSurface>

            <CardSurface className="p-5">
              <p className="text-sm font-semibold text-card-foreground">ZATCA</p>
              <p className="mt-3 text-xs text-muted-foreground">آخر حالة تجهيز محفوظة</p>
              <p className="mt-1 font-mono text-sm font-medium" dir="ltr">
                {detail.operations.zatca.latestProvisioningState ?? '—'}
              </p>
              {detail.operations.zatca.latestProvisioningAt === null ? null : (
                <time
                  className="mt-2 block text-xs text-muted-foreground"
                  dateTime={detail.operations.zatca.latestProvisioningAt}
                >
                  {new Intl.DateTimeFormat('ar-SA', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(detail.operations.zatca.latestProvisioningAt))}
                </time>
              )}
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                لا تُعرض مفاتيح أو شهادات أو أسرار توقيع في هذه الواجهة.
              </p>
            </CardSurface>

            {detail.tenant.suspensionReason === null ? null : (
              <PlatformNotice tone="warning">
                آخر سبب إيقاف: {detail.tenant.suspensionReason}
              </PlatformNotice>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}

export function PlatformTenant({ tenantId }: { readonly tenantId: string }): JSX.Element {
  const [state, setState] = useState<PageState>({ kind: 'checking' });
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    void api
      .session({ signal: controller.signal })
      .then(async (session) => {
        if (!live) return;
        setState({ kind: 'loading', session });
        const [detail, audit] = await Promise.all([
          api.tenant(tenantId, { signal: controller.signal }),
          session.permissions.includes('platform.audit.read')
            ? api.audit(tenantId, { limit: 50 }, { signal: controller.signal })
            : Promise.resolve({ items: [], nextCursor: null }),
        ]);
        if (live) setState({ kind: 'ready', session, detail, audit });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (!live) return;
        if (error instanceof ApiError && error.unauthenticated) {
          setState({ kind: 'signed-out', unavailable: false });
          return;
        }
        if (error instanceof ApiError && error.status === 503) {
          setState({ kind: 'signed-out', unavailable: true });
          return;
        }
        const current = state;
        if (current.kind === 'loading' || current.kind === 'ready' || current.kind === 'failed') {
          setState({ kind: 'failed', session: current.session, message: messageFor(error) });
        } else {
          setState({ kind: 'signed-out', unavailable: false });
        }
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [refreshKey, tenantId]);

  if (state.kind === 'checking') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/20">
        <div role="status" className="text-center">
          <KorviMark size="lg" suffix="PLATFORM" />
          <p className="mt-4 text-sm text-muted-foreground">جارٍ فتح سجل المنشأة…</p>
        </div>
      </main>
    );
  }

  if (state.kind === 'signed-out') {
    return <LoginGate unavailable={state.unavailable} onSignedIn={() => refresh()} />;
  }

  if (state.kind === 'loading') {
    return (
      <main className="mx-auto min-h-screen max-w-[1500px] bg-muted/20 px-4 py-8 sm:px-6 lg:px-8">
        <PlatformSkeletonRows />
      </main>
    );
  }

  if (state.kind === 'failed') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/20 px-4">
        <CardSurface className="w-full max-w-lg p-6">
          <PlatformNotice tone="danger">{state.message}</PlatformNotice>
          <div className="mt-4 flex gap-2">
            <Button onClick={refresh}>إعادة المحاولة</Button>
            <Link
              href="/platform"
              className="inline-flex h-11 items-center justify-center rounded-md border border-input px-4 text-sm font-medium"
            >
              العودة للمنشآت
            </Link>
          </div>
        </CardSurface>
      </main>
    );
  }

  return (
    <DetailView
      session={state.session}
      detail={state.detail}
      audit={state.audit}
      onRefresh={refresh}
      onSignedOut={() => setState({ kind: 'signed-out', unavailable: false })}
    />
  );
}
