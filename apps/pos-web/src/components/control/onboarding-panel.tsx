'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, CardSurface, cn } from '@korvi/ui';
import { StatusNote } from '../status-note';
import { ApiError } from '../../lib/api';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type {
  OnboardingCheckKey,
  OnboardingReadiness,
  OnboardingRemediation,
} from '../../lib/api-types';
import type { ControlSection } from './control-nav';

const LABELS: Readonly<Record<OnboardingCheckKey, string>> = {
  'tenant-active': 'المنشأة مفعّلة',
  'settings-present': 'إعدادات المنشأة موجودة',
  'active-branch': 'يوجد فرع مفعّل',
  'active-terminal': 'يوجد صندوق مفعّل',
  'viable-administrator': 'يوجد مدير بصلاحية فعلية',
  'active-product': 'يوجد صنف مفعّل للبيع',
};

const TARGETS: Readonly<Partial<Record<OnboardingRemediation, ControlSection>>> = {
  'merchant-settings': 'settings',
  'branch-terminal-admin': 'branches',
  'member-role-admin': 'staff',
  'product-catalogue': 'products',
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.serverMessage !== null) return error.serverMessage;
  if (error instanceof ApiError && error.forbidden) {
    return 'لا تملك الصلاحية اللازمة لقراءة جاهزية المنشأة.';
  }
  return 'تعذر قراءة جاهزية المنشأة الآن.';
}

function canOpen(section: ControlSection, permissions: readonly string[]): boolean {
  switch (section) {
    case 'settings':
    case 'branches':
      return permissions.includes('settings.manage');
    case 'staff':
      return permissions.includes('users.manage');
    case 'products':
      return permissions.includes('product.write');
    case 'home':
      return true;
  }
}

export interface OnboardingPanelProps {
  readonly api: ApiClient;
  readonly permissions: readonly string[];
  readonly onNavigate: (section: ControlSection) => void;
}

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly readiness: OnboardingReadiness }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Guided onboarding is a projection of the server's current evidence.
 *
 * This component owns no completion flag and performs no setup mutation. It
 * only reads the authority from /v1/admin/onboarding/readiness and points the
 * administrator at the existing, permission-checked write surfaces. If a
 * branch or product is later disabled, the next read becomes incomplete again.
 */
export function OnboardingPanel({
  api,
  permissions,
  onNavigate,
}: OnboardingPanelProps): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    void api
      .onboardingReadiness({ signal: controller.signal })
      .then((readiness) => setState({ kind: 'ready', readiness }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ kind: 'failed', message: errorMessage(error) });
      });
    return controller;
  }, [api]);

  useEffect(() => {
    const controller = load();
    return () => controller.abort();
  }, [load]);

  const progress = useMemo(() => {
    if (state.kind !== 'ready') return null;
    return {
      complete: state.readiness.checks.filter((check) => check.ready).length,
      total: state.readiness.checks.length,
    };
  }, [state]);

  if (state.kind === 'loading') {
    return (
      <CardSurface className="p-5">
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          جارٍ التحقق من جاهزية المنشأة…
        </p>
      </CardSurface>
    );
  }

  if (state.kind === 'failed') {
    return (
      <CardSurface className="flex flex-col gap-3 p-5">
        <StatusNote tone="warning" live>
          {state.message}
        </StatusNote>
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={() => load()}>
            إعادة التحقق
          </Button>
        </div>
      </CardSurface>
    );
  }

  const readiness = state.readiness;
  if (readiness.ready) {
    return (
      <CardSurface className="border-success/30 p-5">
        <StatusNote tone="success" live>
          المنشأة جاهزة للتشغيل: جميع متطلبات الجاهزية الحالية مثبتة من بيانات النظام.
        </StatusNote>
      </CardSurface>
    );
  }

  return (
    <CardSurface className="p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">إكمال إعداد كورفي</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            هذه الحالة مشتقة من النظام الآن، وليست قائمة تحقق محفوظة أو قابلة للتجاوز.
          </p>
        </div>
        {progress === null ? null : (
          <span className="shrink-0 rounded-full bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
            {progress.complete} / {progress.total}
          </span>
        )}
      </div>

      <div className="mt-4 grid gap-2">
        {readiness.checks.map((check) => {
          const target = check.remediation === null ? undefined : TARGETS[check.remediation];
          const actionable = !check.ready && target !== undefined && canOpen(target, permissions);

          return (
            <div
              key={check.key}
              className={cn(
                'flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between',
                check.ready ? 'border-success/20 bg-success/5' : 'border-border bg-background',
              )}
            >
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold',
                    check.ready
                      ? 'bg-success/10 text-success'
                      : 'bg-warning/10 text-warning-foreground',
                  )}
                >
                  {check.ready ? '✓' : '!'}
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">{LABELS[check.key]}</p>
                  {!check.ready && check.remediation === 'tenant-lifecycle' ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      تفعيل المنشأة من صلاحيات منصة كورفي وليس من حساب التاجر.
                    </p>
                  ) : null}
                  {!check.ready && target !== undefined && !actionable ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      تحتاج صلاحية إضافية لإكمال هذه الخطوة.
                    </p>
                  ) : null}
                </div>
              </div>

              {actionable && target !== undefined ? (
                <Button size="sm" variant="ghost" onClick={() => onNavigate(target)}>
                  فتح الخطوة
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </CardSurface>
  );
}
