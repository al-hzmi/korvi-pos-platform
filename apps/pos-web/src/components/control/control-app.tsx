'use client';

import { useCallback, useMemo, useState } from 'react';
import { Button, CardSurface, KorviMark } from '@korvi/ui';
import { ControlNav } from './control-nav';
import { DashboardPanel } from './dashboard-panel';
import { ProductsPanel } from './products-panel';
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

/**
 * The owner's side of Korvi.
 *
 * The session boundary is the same one the till uses — same hook, same cookie,
 * same server, and the same refusal to call an unconfirmed logout a logout.
 * Hiding the navigation from a cashier is a courtesy; the dashboard route
 * checks `report.read` itself, and an unauthorised request gets a 403 whatever
 * this component renders.
 */
export interface ControlAppProps {
  readonly api?: ApiClient;
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

function Workspace({
  api,
  principal,
  onSignOut,
}: {
  readonly api: ApiClient;
  readonly principal: Principal;
  readonly onSignOut: () => void;
}): JSX.Element {
  const [section, setSection] = useState<ControlSection>('home');
  const permitted = hasPermission(principal, 'report.read');

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
          <a
            href="/"
            className="inline-flex h-touch items-center rounded-md border border-input px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            نقطة البيع
          </a>
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            خروج
          </Button>
        </div>
      </header>

      {!permitted ? (
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
              <ControlNav active={section} onSelect={setSection} />
            </CardSurface>
          </aside>

          <main className="flex min-h-0 flex-1 flex-col gap-4">
            <h1 className="text-2xl font-semibold text-foreground">
              {section === 'home' ? 'الرئيسية' : 'المنتجات'}
            </h1>
            {section === 'home' ? <DashboardPanel api={api} /> : <ProductsPanel api={api} />}
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
}

/**
 * The render half, separated from the session wiring so that every screen —
 * including the one that must never be the login form — can be rendered and
 * asserted on its own.
 */
export function ControlSurface({
  view,
  api,
  onAuthenticated,
  onRetrySession,
  onSignOut,
}: ControlSurfaceProps): JSX.Element {
  if (view.kind === 'waiting') return <Waiting label={view.label} />;

  if (view.kind === 'logout-unconfirmed') {
    // No catalogue, no dashboard, no login form. Retrying the logout is the
    // only way out of this screen, and that is the point of it.
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

  return <Workspace api={api} principal={view.principal} onSignOut={onSignOut} />;
}

export function ControlApp({ api: injected }: ControlAppProps = {}): JSX.Element {
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
    />
  );
}
