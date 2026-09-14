'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, CardSurface, KorviMark } from '@korvi/ui';
import { ApiError } from '../../lib/api';
import {
  createPlatformApi,
  type PlatformLifecycleStatus,
  type PlatformSession,
  type PlatformTenantPage,
  type PlatformVertical,
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

type SessionState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'signed-out'; readonly unavailable: boolean }
  | { readonly kind: 'ready'; readonly session: PlatformSession };

type TenantState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly page: PlatformTenantPage };

const STATUS_OPTIONS: readonly {
  readonly value: '' | PlatformLifecycleStatus;
  readonly label: string;
}[] = [
  { value: '', label: 'كل الحالات' },
  { value: 'active', label: 'نشطة' },
  { value: 'provisioning', label: 'قيد التجهيز' },
  { value: 'suspended', label: 'موقوفة' },
];

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return 'تعذّر الوصول إلى خادم كورفي. تحقق من الاتصال ثم أعد المحاولة.';
    if (error.status === 401) return 'انتهت جلسة إدارة المنصة. سجّل الدخول من جديد.';
    if (error.status === 403) return 'هذه الجلسة لا تملك الصلاحية المطلوبة.';
    if (error.status === 503) return 'إدارة المنصة غير مفعّلة على هذا النشر.';
    return error.serverMessage ?? 'تعذّر إكمال الطلب. أعد المحاولة.';
  }
  return 'حدث خطأ غير متوقع أثناء تنفيذ الطلب.';
}

function LoginScreen({
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
    if (accessKey === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(accessKey);
      setAccessKey('');
      onSignedIn(session);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-6xl items-center justify-center">
        <div className="grid w-full overflow-hidden rounded-xl border border-border bg-card shadow-sm lg:grid-cols-[1.1fr_0.9fr]">
          <section className="hidden border-l border-border bg-primary p-10 text-primary-foreground lg:flex lg:flex-col lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-12 items-center justify-center rounded-lg bg-primary-foreground/10">
                <KorviMark size="md" className="text-primary-foreground" />
              </div>
              <div>
                <p className="text-lg font-semibold">Korvi</p>
                <p className="text-sm text-primary-foreground/70">Platform Operations</p>
              </div>
            </div>
            <div className="max-w-md">
              <p className="text-3xl font-semibold leading-tight">غرفة التحكم التشغيلية للمنصة.</p>
              <p className="mt-4 text-sm leading-7 text-primary-foreground/75">
                إدارة دورة حياة المنشآت، الاشتراكات والصلاحيات التجارية من نطاق منفصل تمامًا عن
                حسابات التجار.
              </p>
            </div>
            <p className="text-xs text-primary-foreground/60">Korvi Control Plane · Internal</p>
          </section>

          <section className="p-6 sm:p-10 lg:p-12">
            <div className="mb-8 flex items-center gap-3 lg:hidden">
              <KorviMark size="md" />
              <div>
                <p className="font-semibold">Korvi</p>
                <p className="text-xs text-muted-foreground">إدارة المنصة</p>
              </div>
            </div>
            <p className="text-xs font-semibold text-primary">PLATFORM ADMIN</p>
            <h1 className="mt-2 text-2xl font-semibold text-card-foreground">دخول إدارة المنصة</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              هذا النطاق مستقل عن دخول المتجر. المفتاح يُرسل مرة واحدة لإنشاء جلسة HttpOnly ولا
              يُحفظ في المتصفح.
            </p>

            <form className="mt-8 space-y-5" onSubmit={submit}>
              <div>
                <label className={PLATFORM_LABEL} htmlFor="platform-access-key">
                  مفتاح الوصول
                </label>
                <input
                  id="platform-access-key"
                  className={PLATFORM_INPUT}
                  type="password"
                  autoComplete="current-password"
                  value={accessKey}
                  disabled={busy || unavailable}
                  onChange={(event) => setAccessKey(event.target.value)}
                  placeholder="أدخل مفتاح إدارة المنصة"
                />
              </div>
              {unavailable ? (
                <PlatformNotice tone="warning">
                  هذا النشر لا يحتوي إعدادات Platform Admin. يلزم تفعيل أسرار المنصة في بيئة الخادم
                  أولًا.
                </PlatformNotice>
              ) : null}
              {error === null ? null : <PlatformNotice tone="danger">{error}</PlatformNotice>}
              <Button
                type="submit"
                className="w-full"
                loading={busy}
                disabled={unavailable || accessKey === ''}
              >
                دخول آمن
              </Button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}

function CreateTenantPanel({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}): JSX.Element | null {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [vatNumber, setVatNumber] = useState('');
  const [vertical, setVertical] = useState<PlatformVertical>('retail');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createTenant({
        operationId: crypto.randomUUID(),
        name,
        slug,
        vatNumber: vatNumber.trim() === '' ? null : vatNumber.trim(),
        vertical,
      });
      setName('');
      setSlug('');
      setVatNumber('');
      setVertical('retail');
      onCreated();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/20 p-0 backdrop-blur-[1px] sm:items-center sm:p-6">
      <CardSurface className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-b-none p-5 shadow-xl sm:rounded-lg sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-card-foreground">إنشاء منشأة</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              ينشئ كورفي هوية المنشأة وإعداداتها وأدوارها الأساسية في معاملة واحدة.
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            إغلاق
          </Button>
        </div>

        <form className="mt-6 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
          <div className="sm:col-span-2">
            <label className={PLATFORM_LABEL} htmlFor="tenant-name">
              اسم المنشأة
            </label>
            <input
              id="tenant-name"
              className={PLATFORM_INPUT}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={200}
            />
          </div>
          <div>
            <label className={PLATFORM_LABEL} htmlFor="tenant-slug">
              المعرّف المختصر
            </label>
            <input
              id="tenant-slug"
              className={PLATFORM_INPUT}
              dir="ltr"
              value={slug}
              onChange={(event) => setSlug(event.target.value.toLowerCase())}
              required
              pattern="[a-z0-9][a-z0-9-]{0,62}"
            />
          </div>
          <div>
            <label className={PLATFORM_LABEL} htmlFor="tenant-vat">
              الرقم الضريبي
            </label>
            <input
              id="tenant-vat"
              className={PLATFORM_INPUT}
              dir="ltr"
              inputMode="numeric"
              value={vatNumber}
              onChange={(event) => setVatNumber(event.target.value)}
              maxLength={64}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={PLATFORM_LABEL} htmlFor="tenant-vertical">
              النشاط
            </label>
            <select
              id="tenant-vertical"
              className={PLATFORM_INPUT}
              value={vertical}
              onChange={(event) => setVertical(event.target.value as PlatformVertical)}
            >
              <option value="retail">تجزئة</option>
              <option value="grocery">بقالة وسوبرماركت</option>
              <option value="restaurant">مطعم ومقهى</option>
              <option value="pharmacy">صيدلية</option>
            </select>
          </div>
          {error === null ? null : (
            <div className="sm:col-span-2">
              <PlatformNotice tone="danger">{error}</PlatformNotice>
            </div>
          )}
          <div className="flex gap-2 sm:col-span-2 sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              إلغاء
            </Button>
            <Button
              type="submit"
              loading={busy}
              disabled={name.trim() === '' || slug.trim() === ''}
            >
              إنشاء المنشأة
            </Button>
          </div>
        </form>
      </CardSurface>
    </div>
  );
}

function TenantDashboard({
  session,
  onSignedOut,
}: {
  readonly session: PlatformSession;
  readonly onSignedOut: () => void;
}): JSX.Element {
  const [state, setState] = useState<TenantState>({ kind: 'loading' });
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [status, setStatus] = useState<'' | PlatformLifecycleStatus>('');
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);

  const canManage = session.permissions.includes('platform.tenants.manage');

  const reload = useCallback(() => setRefreshKey((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setState({ kind: 'loading' });
    void api
      .tenants(
        {
          ...(appliedSearch === '' ? {} : { search: appliedSearch }),
          ...(status === '' ? {} : { status }),
          limit: 100,
        },
        { signal: controller.signal },
      )
      .then((page) => {
        if (live) setState({ kind: 'ready', page });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (error instanceof ApiError && error.unauthenticated) {
          onSignedOut();
          return;
        }
        if (live) setState({ kind: 'failed', message: errorMessage(error) });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [appliedSearch, onSignedOut, refreshKey, status]);

  const counts = useMemo(() => {
    if (state.kind !== 'ready') return { shown: 0, active: 0, provisioning: 0, suspended: 0 };
    return state.page.items.reduce(
      (acc, tenant) => ({
        ...acc,
        shown: acc.shown + 1,
        [tenant.status]: acc[tenant.status] + 1,
      }),
      { shown: 0, active: 0, provisioning: 0, suspended: 0 },
    );
  }, [state]);

  const logout = async () => {
    setLoggingOut(true);
    try {
      await api.logout();
    } finally {
      onSignedOut();
      setLoggingOut(false);
    }
  };

  return (
    <div className="min-h-screen bg-muted/20">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1500px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <KorviMark size="sm" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Korvi Platform</p>
              <p className="truncate text-xs text-muted-foreground">إدارة المنصة</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              جلسة داخلية · {session.permissions.length} صلاحيات
            </span>
            <Button variant="ghost" size="sm" loading={loggingOut} onClick={logout}>
              تسجيل الخروج
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <PlatformPageHeader
          eyebrow="CONTROL PLANE"
          title="المنشآت"
          description="متابعة دورة حياة حسابات التجار وحالة تشغيلها من نطاق إداري مستقل عن لوحة كل منشأة."
          action={
            canManage ? <Button onClick={() => setCreateOpen(true)}>إنشاء منشأة</Button> : undefined
          }
        />

        <section className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <PlatformMetric
            label="المعروضة"
            value={String(counts.shown)}
            detail="ضمن نتيجة البحث الحالية"
          />
          <PlatformMetric label="نشطة" value={String(counts.active)} />
          <PlatformMetric label="قيد التجهيز" value={String(counts.provisioning)} />
          <PlatformMetric label="موقوفة" value={String(counts.suspended)} />
        </section>

        <CardSurface className="mt-5 p-4">
          <form
            className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              setAppliedSearch(search.trim());
            }}
          >
            <div>
              <label htmlFor="platform-tenant-search" className="sr-only">
                بحث المنشآت
              </label>
              <input
                id="platform-tenant-search"
                className={PLATFORM_INPUT}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="ابحث بالاسم أو المعرّف أو الرقم الضريبي"
              />
            </div>
            <div>
              <label htmlFor="platform-status-filter" className="sr-only">
                حالة المنشأة
              </label>
              <select
                id="platform-status-filter"
                className={PLATFORM_INPUT}
                value={status}
                onChange={(event) => setStatus(event.target.value as '' | PlatformLifecycleStatus)}
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" variant="outline">
              تطبيق البحث
            </Button>
          </form>
        </CardSurface>

        <section className="mt-5">
          {state.kind === 'loading' ? <PlatformSkeletonRows /> : null}
          {state.kind === 'failed' ? (
            <PlatformNotice tone="danger">
              {state.message}{' '}
              <button
                className="font-semibold underline underline-offset-4"
                type="button"
                onClick={reload}
              >
                إعادة المحاولة
              </button>
            </PlatformNotice>
          ) : null}
          {state.kind === 'ready' && state.page.items.length === 0 ? (
            <PlatformEmpty
              title="لا توجد نتائج"
              description="غيّر عبارة البحث أو الحالة، أو أنشئ منشأة جديدة إذا كان هذا حسابًا جديدًا."
            />
          ) : null}
          {state.kind === 'ready' && state.page.items.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
              <div className="hidden grid-cols-[minmax(220px,1.5fr)_minmax(150px,0.8fr)_140px_170px] gap-4 border-b border-border bg-muted/50 px-4 py-3 text-xs font-semibold text-muted-foreground md:grid">
                <span>المنشأة</span>
                <span>المعرّف</span>
                <span>الحالة</span>
                <span>تاريخ الإنشاء</span>
              </div>
              {state.page.items.map((tenant) => (
                <Link
                  key={tenant.id}
                  href={`/platform/tenants/${tenant.id}`}
                  className="grid min-h-[76px] gap-3 border-b border-border/70 px-4 py-4 transition-colors last:border-b-0 hover:bg-muted/40 md:grid-cols-[minmax(220px,1.5fr)_minmax(150px,0.8fr)_140px_170px] md:items-center"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-card-foreground">
                      {tenant.name}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted-foreground" dir="ltr">
                      {tenant.vatNumber ?? 'بدون رقم ضريبي'}
                    </p>
                  </div>
                  <span className="truncate font-mono text-xs text-muted-foreground" dir="ltr">
                    {tenant.slug}
                  </span>
                  <div>
                    <PlatformStatusBadge status={tenant.status} />
                  </div>
                  <time className="text-xs text-muted-foreground" dateTime={tenant.createdAt}>
                    {new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium' }).format(
                      new Date(tenant.createdAt),
                    )}
                  </time>
                </Link>
              ))}
            </div>
          ) : null}
        </section>
      </main>

      <CreateTenantPanel
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={reload}
      />
    </div>
  );
}

export function PlatformApp(): JSX.Element {
  const [sessionState, setSessionState] = useState<SessionState>({ kind: 'checking' });

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    void api
      .session({ signal: controller.signal })
      .then((session) => {
        if (live) setSessionState({ kind: 'ready', session });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (!live) return;
        setSessionState({
          kind: 'signed-out',
          unavailable: error instanceof ApiError && error.status === 503,
        });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, []);

  if (sessionState.kind === 'checking') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/20 px-4">
        <div className="text-center" role="status">
          <KorviMark size="lg" className="mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">جارٍ التحقق من جلسة إدارة المنصة…</p>
        </div>
      </main>
    );
  }

  if (sessionState.kind === 'signed-out') {
    return (
      <LoginScreen
        unavailable={sessionState.unavailable}
        onSignedIn={(session) => setSessionState({ kind: 'ready', session })}
      />
    );
  }

  return (
    <TenantDashboard
      session={sessionState.session}
      onSignedOut={() => setSessionState({ kind: 'signed-out', unavailable: false })}
    />
  );
}
