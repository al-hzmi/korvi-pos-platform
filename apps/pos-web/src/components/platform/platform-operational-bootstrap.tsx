'use client';

import { useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { PLATFORM_INPUT, PLATFORM_LABEL, PlatformNotice } from './platform-ui';
import type { FormEvent, JSX } from 'react';

interface OperationalBootstrapResult {
  readonly branch: {
    readonly id: string;
    readonly code: string;
    readonly nameAr: string;
    readonly nameEn: string | null;
    readonly isActive: boolean;
  };
  readonly terminal: {
    readonly id: string;
    readonly branchId: string;
    readonly code: string;
    readonly label: string;
    readonly isActive: boolean;
  };
  readonly replayed: boolean;
}

function responseMessage(status: number, code: string | null): string {
  if (status === 401) return 'انتهت جلسة إدارة المنصة. سجّل الدخول من جديد.';
  if (status === 403) return 'الجلسة لا تملك صلاحية تجهيز التشغيل.';
  if (status === 404) return 'المنشأة غير موجودة.';
  if (status === 409 && code === 'tenant_suspended')
    return 'المنشأة موقوفة. أعد تفعيلها قبل تجهيز الفرع ونقطة البيع.';
  if (status === 409 && code === 'branch_code_taken')
    return 'رمز الفرع مستخدم داخل هذه المنشأة.';
  if (status === 409 && code === 'terminal_code_taken')
    return 'رمز نقطة البيع مستخدم داخل هذه المنشأة.';
  if (status === 409 && code === 'idempotency_conflict')
    return 'رقم العملية مرتبط ببيانات مختلفة. أعد المحاولة بعملية جديدة.';
  if (status === 422) return 'تحقق من رموز وأسماء الفرع ونقطة البيع.';
  if (status === 503) return 'خدمة التجهيز التشغيلي غير مهيأة على هذا النشر.';
  return 'تعذّر تجهيز الفرع ونقطة البيع.';
}

export function PlatformOperationalBootstrap({
  tenantId,
}: {
  readonly tenantId: string;
}): JSX.Element {
  const [branchCode, setBranchCode] = useState('BR-01');
  const [branchNameAr, setBranchNameAr] = useState('الفرع الرئيسي');
  const [branchNameEn, setBranchNameEn] = useState('');
  const [terminalCode, setTerminalCode] = useState('POS-01');
  const [terminalLabel, setTerminalLabel] = useState('الكاشير الرئيسي');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OperationalBootstrapResult | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const nextOperationId = operationId ?? crypto.randomUUID();
    setOperationId(nextOperationId);
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/v1/platform/tenants/${encodeURIComponent(tenantId)}/operational-bootstrap`,
        {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            operationId: nextOperationId,
            branch: {
              code: branchCode.trim(),
              nameAr: branchNameAr.trim(),
              nameEn: branchNameEn.trim() === '' ? null : branchNameEn.trim(),
            },
            terminal: {
              code: terminalCode.trim(),
              label: terminalLabel.trim(),
            },
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
        const failure = new Error(responseMessage(response.status, code));
        (failure as Error & { definitive?: boolean }).definitive = response.status < 500;
        throw failure;
      }

      setResult(body as OperationalBootstrapResult);
      setOperationId(null);
    } catch (caught) {
      if (caught instanceof TypeError) {
        setError('انقطع الاتصال قبل وصول التأكيد. أعد المحاولة؛ رقم العملية محفوظ لإعادة آمنة.');
      } else {
        setError(caught instanceof Error ? caught.message : 'تعذّر تجهيز الفرع ونقطة البيع.');
        if ((caught as Error & { definitive?: boolean }).definitive === true) setOperationId(null);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1500px] px-4 pb-5 sm:px-6 lg:px-8">
      <CardSurface className="p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold text-card-foreground">تجهيز التشغيل الأولي</p>
            <p className="mt-1 text-xs leading-6 text-muted-foreground">
              ينشئ كورفي الفرع ونقطة البيع في معاملة واحدة. إذا فشل أي جزء فلن يبقى فرع أو جهاز
              نصف مهيأ، وإعادة نفس العملية آمنة.
            </p>
          </div>
          <span className="rounded-md bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary">
            BRANCH + TERMINAL
          </span>
        </div>

        {result === null ? (
          <form className="mt-5 grid gap-4 md:grid-cols-2" onSubmit={submit}>
            <div>
              <label className={PLATFORM_LABEL} htmlFor="platform-branch-code">
                رمز الفرع
              </label>
              <input
                id="platform-branch-code"
                className={PLATFORM_INPUT}
                dir="ltr"
                value={branchCode}
                maxLength={64}
                onChange={(event) => setBranchCode(event.target.value)}
                required
              />
            </div>
            <div>
              <label className={PLATFORM_LABEL} htmlFor="platform-branch-name-ar">
                اسم الفرع
              </label>
              <input
                id="platform-branch-name-ar"
                className={PLATFORM_INPUT}
                value={branchNameAr}
                maxLength={200}
                onChange={(event) => setBranchNameAr(event.target.value)}
                required
              />
            </div>
            <div>
              <label className={PLATFORM_LABEL} htmlFor="platform-branch-name-en">
                اسم الفرع بالإنجليزية — اختياري
              </label>
              <input
                id="platform-branch-name-en"
                className={PLATFORM_INPUT}
                dir="ltr"
                value={branchNameEn}
                maxLength={200}
                onChange={(event) => setBranchNameEn(event.target.value)}
              />
            </div>
            <div aria-hidden="true" className="hidden md:block" />
            <div>
              <label className={PLATFORM_LABEL} htmlFor="platform-terminal-code">
                رمز نقطة البيع
              </label>
              <input
                id="platform-terminal-code"
                className={PLATFORM_INPUT}
                dir="ltr"
                value={terminalCode}
                maxLength={64}
                onChange={(event) => setTerminalCode(event.target.value)}
                required
              />
            </div>
            <div>
              <label className={PLATFORM_LABEL} htmlFor="platform-terminal-label">
                اسم نقطة البيع
              </label>
              <input
                id="platform-terminal-label"
                className={PLATFORM_INPUT}
                value={terminalLabel}
                maxLength={200}
                onChange={(event) => setTerminalLabel(event.target.value)}
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
                disabled={
                  branchCode.trim() === '' ||
                  branchNameAr.trim() === '' ||
                  terminalCode.trim() === '' ||
                  terminalLabel.trim() === ''
                }
              >
                إنشاء الفرع ونقطة البيع
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-5 space-y-4">
            <PlatformNotice tone="neutral">
              {result.replayed
                ? 'تم تأكيد العملية السابقة بدون إنشاء نسخة مكررة.'
                : 'تم إنشاء الفرع ونقطة البيع وتفعيلهما.'}
            </PlatformNotice>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border bg-muted/30 p-4">
                <p className="text-xs text-muted-foreground">الفرع</p>
                <p className="mt-1 text-sm font-semibold">{result.branch.nameAr}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground" dir="ltr">
                  {result.branch.code}
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-4">
                <p className="text-xs text-muted-foreground">نقطة البيع</p>
                <p className="mt-1 text-sm font-semibold">{result.terminal.label}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground" dir="ltr">
                  {result.terminal.code}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => window.location.reload()}>
                تحديث حالة المنشأة
              </Button>
              <Button type="button" variant="ghost" onClick={() => setResult(null)}>
                تجهيز زوج آخر
              </Button>
            </div>
          </div>
        )}
      </CardSurface>
    </div>
  );
}
