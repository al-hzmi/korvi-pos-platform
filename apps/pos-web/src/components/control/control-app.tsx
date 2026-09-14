'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, CardSurface, KorviMark } from '@korvi/ui';
import { BranchesPanel } from './branches-panel';
import {
  ControlNav,
  controlSectionHref,
  firstAuthorizedSection,
  resolveControlRoute,
} from './control-nav';
import { DashboardPanel } from './dashboard-panel';
import { InventoryPanel } from './inventory-panel';
import { MembersPanel } from './members-panel';
import { OnboardingPanel } from './onboarding-panel';
import { ProductsPanel } from './products-panel';
import { PurchasingPanel } from './purchasing-panel';
import { SettingsPanel } from './settings-panel';
import { LoginScreen } from '../login-screen';
import { Screen } from '../screen';
import { StatusNote } from '../status-note';
import { BlockedScreen } from '../terminal-picker';
import { controlView } from '../../lib/control-view';
import { createApiClient } from '../../lib/api';
import { hasPermission } from '../../lib/session';
import { useSession } from '../../hooks/use-session';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type { ControlView } from '../../lib/control-view';
import type { Principal } from '../../lib/api-types';
import type { ControlSection } from './control-nav';

export interface ControlAppProps {
  readonly api?: ApiClient;
  readonly requestedSection?: string | null;
}

function Waiting({ label }: { readonly label: string }): JSX.Element {
  return (
    <Screen title="لوحة تحكم كورفي">
      <CardSurface className="p-6">
        <p className="text-center text-sm text-muted-foreground" role="status" aria-live="polite">
          {label}
        </p>
      </CardSurface>
    </Screen>
  );
}

function sectionTitle(section: ControlSection): string {
  switch (section) {
    case 'home':
      return 'الرئيسية';
    case 'products':
      return 'المنتجات';
    case 'inventory':
      return 'المخزون';
    case 'purchasing':
      return 'المشتريات';
    case 'branches':
      return 'الفروع والصناديق';
    case 'staff':
      return 'الموظفون والصلاحيات';
    case 'settings':
      return 'إعدادات المنشأة';
  }
}

export function preserveCommandBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = true;
}

function Section({
  section,
  api,
  principal,
  onCommandLockChange,
}: {
  readonly section: ControlSection;
  readonly api: ApiClient;
  readonly principal: Principal;
  readonly onCommandLockChange: (locked: boolean) => void;
}): JSX.Element {
  switch (section) {
    case 'home':
      return <DashboardPanel api={api} />;
    case 'products':
      return <ProductsPanel api={api} canWrite={hasPermission(principal, 'product.write')} />;
    case 'inventory':
      return (
        <InventoryPanel
          api={api}
          preferredBranchId={principal.branchId}
          permissions={principal.permissions}
          onCommandLockChange={onCommandLockChange}
        />
      );
    case 'purchasing':
      return (
        <PurchasingPanel
          api={api}
          permissions={principal.permissions}
          onCommandLockChange={onCommandLockChange}
        />
      );
    case 'branches':
      return <BranchesPanel api={api} />;
    case 'staff':
      return (
        <MembersPanel api={api} canManageSettings={hasPermission(principal, 'settings.manage')} />
      );
    case 'settings':
      return <SettingsPanel api={api} />;
  }
}

type RouteProblemRoute =
  | { readonly kind: 'forbidden'; readonly section: ControlSection }
  | { readonly kind: 'invalid' };

function RouteProblem({
  route,
  fallback,
}: {
  readonly route: RouteProblemRoute;
  readonly fallback: ControlSection | null;
}): JSX.Element {
  const message =
    route.kind === 'forbidden'
      ? `لا تملك صلاحية فتح قسم ${sectionTitle(route.section)} في هذه الجلسة.`
      : 'رابط لوحة التحكم المطلوب غير معروف.';

  return (
    <CardSurface className="flex max-w-2xl flex-col gap-4 p-6">
      <StatusNote tone="warning" live>
        {message}
      </StatusNote>
      <p className="text-sm text-muted-foreground">
        لم ننقلك إلى قسم آخر تلقائيًا حتى يبقى الرابط الحالي صريحًا وآمنًا عند التحديث والرجوع.
      </p>
      {fallback === null ? null : (
        <div>
          <a
            href={controlSectionHref(fallback)}
            className="inline-flex h-touch items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            العودة إلى {sectionTitle(fallback)}
          </a>
        </div>
      )}
    </CardSurface>
  );
}

function Workspace({
  api,
  principal,
  onSignOut,
  requestedSection,
}: {
  readonly api: ApiClient;
  readonly principal: Principal;
  readonly onSignOut: () => void;
  readonly requestedSection: string | null;
}): JSX.Element {
  const route = resolveControlRoute(requestedSection, principal.permissions);
  const fallbackSection = firstAuthorizedSection(principal.permissions);
  const activeSection = route.kind === 'section' ? route.section : null;
  const [commandLocked, setCommandLocked] = useState(false);
  const canReadOnboarding = hasPermission(principal, 'settings.manage');

  useEffect(() => {
    if (!commandLocked) return undefined;
    window.addEventListener('beforeunload', preserveCommandBeforeUnload);
    return () => window.removeEventListener('beforeunload', preserveCommandBeforeUnload);
  }, [commandLocked]);

  return (
    <div className="flex min-h-screen flex-col bg-muted/40">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-4">
        <div className="flex items-center gap-4">
          <KorviMark size="sm" suffix="CONTROL" />
          <span className="hidden text-sm text-muted-foreground sm:inline">لوحة التحكم</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm font-medium text-foreground md:inline">
            {principal.user.displayName}
          </span>
          {commandLocked ? (
            <span
              aria-disabled="true"
              className="inline-flex h-touch cursor-not-allowed items-center rounded-md border border-input px-4 text-sm text-muted-foreground"
            >
              نقطة البيع
            </span>
          ) : (
            <a
              href="/"
              className="inline-flex h-touch items-center rounded-md border border-input px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              نقطة البيع
            </a>
          )}
          <Button variant="ghost" disabled={commandLocked} onClick={onSignOut}>
            خروج
          </Button>
        </div>
      </header>

      {route.kind === 'none' ? (
        <main className="mx-auto w-full max-w-lg p-6">
          <CardSurface className="flex flex-col gap-4 p-6">
            <StatusNote tone="warning" live>
              لا تملك صلاحية الاطلاع على لوحة التحكم. راجع مدير المنشأة.
            </StatusNote>
            <a
              href="/"
              className="inline-flex h-touch items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              الانتقال إلى نقطة البيع
            </a>
          </CardSurface>
        </main>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
          <aside className="w-full shrink-0 lg:w-64" aria-label="التنقل">
            <CardSurface className="p-2">
              <ControlNav
                active={activeSection}
                permissions={principal.permissions}
                locked={commandLocked}
              />
            </CardSurface>
          </aside>

          <main className="flex min-h-0 flex-1 flex-col gap-4">
            {activeSection === null ? null : (
              <div>
                <h1 className="text-2xl font-semibold text-foreground">
                  {sectionTitle(activeSection)}
                </h1>
                {activeSection === 'inventory' ||
                activeSection === 'purchasing' ||
                activeSection === 'branches' ||
                activeSection === 'staff' ||
                activeSection === 'settings' ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    إدارة المنشأة من صلاحيات جلستك الحالية؛ الخادم هو صاحب القرار النهائي لكل تغيير.
                  </p>
                ) : null}
              </div>
            )}

            {route.kind === 'invalid' || route.kind === 'forbidden' ? (
              <RouteProblem route={route} fallback={fallbackSection} />
            ) : null}

            {activeSection === 'home' && canReadOnboarding ? (
              <OnboardingPanel
                api={api}
                permissions={principal.permissions}
                onNavigate={(section) => {
                  window.location.assign(controlSectionHref(section));
                }}
              />
            ) : null}

            {activeSection === null ? null : (
              <Section
                section={activeSection}
                api={api}
                principal={principal}
                onCommandLockChange={setCommandLocked}
              />
            )}
          </main>
        </div>
      )}
    </div>
  );
}

export interface ControlSurfaceProps {
  readonly view: ControlView;
  readonly api: ApiClient;
  readonly onAuthenticated: (principal: Principal) => void;
  readonly onRetrySession: () => void;
  readonly onSignOut: () => void;
  readonly requestedSection?: string | null;
}

export function ControlSurface({
  view,
  api,
  onAuthenticated,
  onRetrySession,
  onSignOut,
  requestedSection = null,
}: ControlSurfaceProps): JSX.Element {
  if (view.kind === 'waiting') return <Waiting label={view.label} />;

  if (view.kind === 'logout-unconfirmed') {
    return (
      <BlockedScreen
        title="لم يتم تأكيد الخروج"
        tone="danger"
        failure={view.failure}
        onRetry={onSignOut}
        retryLabel="إعادة محاولة تسجيل الخروج"
      />
    );
  }

  if (view.kind === 'unavailable') {
    return (
      <Screen title="الخدمة غير متاحة">
        <CardSurface className="flex flex-col gap-4 p-6">
          <StatusNote tone="warning" live>
            {view.failure.message}
          </StatusNote>
          <Button size="lg" onClick={onRetrySession}>
            إعادة المحاولة
          </Button>
        </CardSurface>
      </Screen>
    );
  }

  if (view.kind === 'login') {
    return <LoginScreen api={api} onAuthenticated={onAuthenticated} notice={view.notice} />;
  }

  return (
    <Workspace
      api={api}
      principal={view.principal}
      onSignOut={onSignOut}
      requestedSection={requestedSection}
    />
  );
}

export function ControlApp({
  api: injected,
  requestedSection = null,
}: ControlAppProps = {}): JSX.Element {
  const api = useMemo(() => injected ?? createApiClient(), [injected]);
  const session = useSession(api);

  const signOut = useCallback(() => {
    session.signOut();
  }, [session]);

  return (
    <ControlSurface
      view={controlView(session.state)}
      api={api}
      onAuthenticated={session.signedIn}
      onRetrySession={session.retry}
      onSignOut={signOut}
      requestedSection={requestedSection}
    />
  );
}
