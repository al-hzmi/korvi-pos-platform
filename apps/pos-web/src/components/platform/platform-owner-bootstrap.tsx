'use client';

import { useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { PLATFORM_INPUT, PLATFORM_LABEL, PlatformNotice } from './platform-ui';
import type { FormEvent, JSX } from 'react';

interface InvitationResult {
  readonly invitationId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly expiresAt: string;
  readonly capability: string;
  readonly created: boolean;
}

function responseMessage(status: number, code: string | null): string {
  if (status === 401) return 'انتهت جلسة إدارة المنصة. سجّل الدخول من جديد.';
  if (status === 403) return 'الجلسة لا تملك صلاحية تجهيز المالك.';
  if (status === 404) return 'المنشأة غير موجودة.';
  if (status === 409 && code === 'already_established') return 'تم إنشاء مالك لهذه المنشأة مسبقًا.';
  if (status === 409 && code === 'already_invited')
    return 'يوجد رابط تفعيل صالح بالفعل. استخدم نفس العملية أو انتظر انتهاء صلاحيته.';
  if (status === 409 && code === 'idempotency_conflict')
    return 'رقم العملية مستخدم لطلب مختلف. أعد المحاولة بعملية جديدة.';
  if (status === 422) return 'تحقق من اسم المالك والبريد الإلكتروني.';
  if (status === 503) return 'خدمة تفعيل المالك غير مهيأة على هذا النشر.';
  return 'تعذّر إصدار رابط التفعيل. أعد المحاولة.';
}

export function PlatformOwnerBootstrap({ tenantId }: { readonly tenantId: string }): JSX.Element {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InvitationResult | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const activationUrl =
    result === null || typeof window === 'undefined'
      ? null
      : `${window.location.origin}/bootstrap/owner#token=${encodeURIComponent(result.capability)}`;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const nextOperationId = operationId ?? crypto.randomUUID();
    setOperationId(nextOperationId);
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const response = await fetch(
        `/v1/platform/tenants/${encodeURIComponent(tenantId)}/owner-bootstrap`,
        {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            operationId: nextOperationId,
            email: email.trim(),
            displayName: displayName.trim(),
          }),
        },
      );
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code =
          body !== null &&
          typeof body === 'object' &&
          typeof (body as { error?: unknown }).error === 'string'
            ? ((body as { error: string }).error ?? null)
            : null;
        throw new Error(responseMessage(response.status, code));
      }
      const invitation = body as InvitationResult;
      setResult(invitation);
      setOperationId(null);
    } catch (caught) {
      if (caught instanceof TypeError) {
        setError('انقطع الاتصال قبل وصول التأكيد. أعد المحاولة؛ رقم العملية محفوظ لإعادة آمنة.');
      } else {
        setError(caught instanceof Error ? caught.message : 'تعذّر إصدار رابط التفعيل.');
        setOperationId(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (activationUrl === null) return;
    await navigator.clipboard.writeText(activationUrl);
    setCopied(true);
  };

  return (
    <div className="mx-auto max-w-[1500px] px-4 pb-5 sm:px-6 lg:px-8">
      <CardSurface className="p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold text-card-foreground">تجهيز مالك المنشأة</p>
            <p className="mt-1 text-xs leading-6 text-muted-foreground">
              يصدر كورفي رابط تفعيل أحادي الاستخدام. موظف المنصة لا يحدد كلمة مرور العميل ولا
              يملكها؛ المالك يختارها بنفسه ثم يسجل الدخول من المسار المعتاد.
            </p>
          </div>
          <span className="rounded-md bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary">
            OWNER BOOTSTRAP
          </span>
        </div>

        {result === null ? (
          <form className="mt-5 grid gap-4 md:grid-cols-2" onSubmit={submit}>
            <div>
              <label className={PLATFORM_LABEL} htmlFor="platform-owner-name">
                اسم المالك
              </label>
              <input
                id="platform-owner-name"
                className={PLATFORM_INPUT}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={160}
                autoComplete="name"
                required
              />
            </div>
            <div>
              <label className={PLATFORM_LABEL} htmlFor="platform-owner-email">
                البريد الإلكتروني
              </label>
              <input
                id="platform-owner-email"
                className={PLATFORM_INPUT}
                dir="ltr"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                maxLength={254}
                autoComplete="email"
                required
              />
            </div>
            {error === null ? null : (
              <div className="md:col-span-2">
                <PlatformNotice tone="danger">{error}</PlatformNotice>
              </div>
            )}
            <div className="md:col-span-2 md:flex md:justify-end">
              <Button
                type="submit"
                loading={busy}
                disabled={displayName.trim() === '' || email.trim() === ''}
              >
                إصدار رابط تفعيل المالك
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-5 space-y-4">
            <PlatformNotice tone="success">
              تم إصدار رابط التفعيل. لا يُحفظ الرابط الخام داخل قاعدة البيانات، وسيختفي من هذه
              الشاشة عند تحديث الصفحة.
            </PlatformNotice>
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <p className="text-xs font-medium text-muted-foreground">البريد المربوط بالدعوة</p>
              <p className="mt-1 break-all font-mono text-sm" dir="ltr">
                {result.email}
              </p>
              <p className="mt-3 text-xs font-medium text-muted-foreground">تنتهي الصلاحية</p>
              <p className="mt-1 text-sm">
                {new Intl.DateTimeFormat('ar-SA', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(result.expiresAt))}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => void copyLink()}
                disabled={activationUrl === null}
              >
                {copied ? 'تم نسخ الرابط' : 'نسخ رابط التفعيل'}
              </Button>
              {activationUrl === null ? null : (
                <a
                  className="inline-flex min-h-11 items-center justify-center rounded-md border border-border px-4 text-sm font-medium hover:bg-muted"
                  href={activationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  فتح صفحة التفعيل
                </a>
              )}
              <Button type="button" variant="ghost" onClick={() => setResult(null)}>
                إخفاء الرابط
              </Button>
            </div>
          </div>
        )}
      </CardSurface>
    </div>
  );
}
