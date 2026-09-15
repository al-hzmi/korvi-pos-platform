'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, CardSurface, KorviMark } from '@korvi/ui';
import type { FormEvent, JSX } from 'react';

function readCapabilityFromFragment(): string | null {
  const fragment = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const token = new URLSearchParams(fragment).get('token');
  // The fragment never crosses HTTP, but it can still leak through screenshots,
  // browser history or a copied address. Keep it only in component memory.
  window.history.replaceState(null, '', window.location.pathname);
  return token === null || token === '' ? null : token;
}

export function OwnerBootstrapForm(): JSX.Element {
  const [token, setToken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    setToken(readCapabilityFromFragment());
    setLoaded(true);
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || token === null) return;
    if (password !== confirm) {
      setError('كلمتا المرور غير متطابقتين.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/v1/bootstrap/owner', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (response.status === 204) {
        setToken(null);
        setPassword('');
        setConfirm('');
        setComplete(true);
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const code =
        body !== null &&
        typeof body === 'object' &&
        typeof (body as { error?: unknown }).error === 'string'
          ? (body as { error: string }).error
          : null;
      if (response.status === 400 && code === 'weak_password') {
        setError('كلمة المرور لا تحقق متطلبات الأمان. اختر كلمة مرور أطول وأقوى وغير شائعة.');
      } else if (response.status === 403) {
        setError('رابط التفعيل غير صالح أو انتهت صلاحيته أو استُخدم مسبقًا. اطلب رابطًا جديدًا.');
        setToken(null);
      } else if (response.status === 503) {
        setError('خدمة تفعيل المالك غير متاحة على هذا النشر.');
      } else {
        setError('تعذّر إكمال التفعيل. أعد المحاولة.');
      }
    } catch {
      setError('تعذّر الوصول إلى كورفي. تحقق من الاتصال ثم أعد المحاولة بنفس الصفحة.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/20 px-4 py-10">
      <CardSurface className="w-full max-w-lg p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <KorviMark size="md" />
          <div>
            <p className="text-sm font-semibold">Korvi</p>
            <p className="text-xs text-muted-foreground">تفعيل مالك المنشأة</p>
          </div>
        </div>

        {complete ? (
          <div className="mt-8">
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
              <h1 className="text-lg font-semibold text-card-foreground">تم إنشاء حساب المالك</h1>
              <p className="mt-2 text-sm leading-7 text-muted-foreground">
                تم استهلاك رابط التفعيل بنجاح. سجّل الدخول الآن برمز المنشأة والبريد وكلمة المرور
                التي اخترتها.
              </p>
            </div>
            <Link
              className="mt-5 inline-flex min-h-11 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              href="/"
            >
              الانتقال إلى تسجيل الدخول
            </Link>
          </div>
        ) : !loaded ? (
          <p className="mt-8 text-sm text-muted-foreground" role="status">
            جارٍ التحقق من رابط التفعيل…
          </p>
        ) : token === null ? (
          <div className="mt-8">
            <h1 className="text-xl font-semibold text-card-foreground">رابط التفعيل غير متاح</h1>
            <p className="mt-2 text-sm leading-7 text-muted-foreground">
              افتح رابط التفعيل الذي أصدرته إدارة كورفي. إذا انتهت صلاحيته فاطلب رابطًا جديدًا.
            </p>
            {error === null ? null : (
              <p className="mt-4 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        ) : (
          <>
            <h1 className="mt-8 text-xl font-semibold text-card-foreground">
              اختر كلمة مرور المالك
            </h1>
            <p className="mt-2 text-sm leading-7 text-muted-foreground">
              كلمة المرور تُرسل مباشرة إلى خادم كورفي لتجزئتها أمنيًا. لا يستطيع موظف المنصة قراءتها
              أو استعادتها.
            </p>
            <form className="mt-6 space-y-4" onSubmit={submit}>
              <div>
                <label
                  className="mb-1.5 block text-xs font-medium text-foreground"
                  htmlFor="owner-password"
                >
                  كلمة المرور
                </label>
                <input
                  id="owner-password"
                  className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-ring"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  maxLength={1024}
                  required
                />
              </div>
              <div>
                <label
                  className="mb-1.5 block text-xs font-medium text-foreground"
                  htmlFor="owner-password-confirm"
                >
                  تأكيد كلمة المرور
                </label>
                <input
                  id="owner-password-confirm"
                  className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none ring-offset-background focus:ring-2 focus:ring-ring"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  maxLength={1024}
                  required
                />
              </div>
              {error === null ? null : (
                <p className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button
                className="w-full"
                type="submit"
                loading={busy}
                disabled={password === '' || confirm === ''}
              >
                إنشاء حساب المالك
              </Button>
            </form>
          </>
        )}
      </CardSurface>
    </main>
  );
}
