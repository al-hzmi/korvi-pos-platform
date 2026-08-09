'use client';

import { useCallback, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { Field } from './field';
import { Screen } from './screen';
import { StatusNote } from './status-note';
import { describeFailure } from '../lib/failures';
import type { JSX } from 'react';
import type { ApiClient } from '../lib/api';
import type { Principal } from '../lib/api-types';
import type { Failure } from '../lib/failures';

/**
 * The way in.
 *
 * Three fields, one generic failure, and no token anywhere. On success the
 * server sets an HttpOnly cookie the browser manages and this code cannot
 * read; the response body is used only for the cashier's name and the
 * affordances to show.
 *
 * The failure message never says which field was wrong. "No such establishment"
 * and "wrong password" are two free probes, and a cashier cannot act on the
 * difference anyway.
 */
export interface LoginScreenProps {
  readonly api: ApiClient;
  readonly onAuthenticated: (principal: Principal) => void;
  readonly notice?: Failure | null;
}

export function LoginScreen({ api, onAuthenticated, notice }: LoginScreenProps): JSX.Element {
  const [tenantSlug, setTenantSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      // The commonest way to submit a form twice is to press Enter twice
      // before the first request returns.
      if (busy) return;
      setBusy(true);
      setFailure(null);
      try {
        onAuthenticated(await api.login({ tenantSlug, email, password }));
      } catch (error) {
        setFailure(describeFailure(error));
        setPassword('');
      } finally {
        setBusy(false);
      }
    },
    [api, busy, tenantSlug, email, password, onAuthenticated],
  );

  const shown = failure ?? notice ?? null;

  return (
    <Screen title="تسجيل الدخول" subtitle="نقطة بيع كورفي" footer="صُدرت عبر Korvi">
      <CardSurface className="p-6">
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          {shown === null ? null : (
            <StatusNote tone={shown.action === 'retry-same' ? 'warning' : 'danger'} live>
              {shown.message}
            </StatusNote>
          )}

          <Field
            id="tenant-slug"
            label="رمز المنشأة"
            name="organization"
            autoComplete="organization"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            dir="ltr"
            required
            autoFocus
            disabled={busy}
            value={tenantSlug}
            onChange={(event) => {
              setTenantSlug(event.target.value);
            }}
          />

          <Field
            id="email"
            label="البريد الإلكتروني"
            name="email"
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            dir="ltr"
            required
            disabled={busy}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />

          <Field
            id="password"
            label="كلمة المرور"
            name="password"
            type={revealed ? 'text' : 'password'}
            autoComplete="current-password"
            dir="ltr"
            required
            disabled={busy}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            trailing={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={revealed}
                aria-label={revealed ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                disabled={busy}
                onClick={() => {
                  setRevealed((value) => !value);
                }}
              >
                {revealed ? 'إخفاء' : 'إظهار'}
              </Button>
            }
          />

          <Button type="submit" size="lg" loading={busy} className="mt-2 w-full">
            {busy ? 'جارٍ التحقق…' : 'دخول'}
          </Button>
        </form>
      </CardSurface>
    </Screen>
  );
}
