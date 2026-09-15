'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { LoginScreen } from './login-screen';
import { Screen } from './screen';
import { StatusNote } from './status-note';
import { BlockedScreen, TerminalPicker } from './terminal-picker';
import { ShiftGate } from './shift-gate';
import { CashierScreen } from './cashier-screen';
import { FOREIGN_SHIFT } from '../lib/shift';
import { LOGOUT_UNCONFIRMED } from '../lib/session';
import { readOfflineWorkspace, writeOfflineWorkspace } from '../lib/offline-workspace';
import { prefersMerchantControl } from '../lib/merchant-landing';
import { useSession } from '../hooks/use-session';
import { useTerminal } from '../hooks/use-terminal';
import { useShift } from '../hooks/use-shift';
import type { JSX } from 'react';
import type { ApiClient } from '../lib/api';
import type { OfflineWorkspaceSnapshot } from '../lib/offline-workspace';

/**
 * One decision, made in one place: which screen is the cashier on.
 *
 * The ordinary path remains server-derived: session, till, drawer, selling.
 * The only exception is a bounded local-workspace lease captured after those
 * three server checks have all succeeded. If a later application start cannot
 * reach the server, that snapshot may reopen the exact same cashier workspace
 * so the till can queue local sales. It carries no token and grants no server
 * authority; every queued command is still reconciled by the server later.
 *
 * Product routing and API transport are deliberately host-owned. This runtime
 * has no Next import, no Control route literal and no browser fetch binding.
 * Web binds the same-origin cookie client; installed Cashier must inject its
 * native transport instead.
 */
export interface PosAppProps {
  /** Required host transport. The cashier runtime never guesses one. */
  readonly api: ApiClient;
  /**
   * Browser host capability only. When supplied, a management-oriented
   * authenticated principal may be handed back to the host before terminal and
   * shift loading begins. Installed Cashier omits it.
   */
  readonly onManagementLanding?: (() => void) | undefined;
  /** Optional host-owned Control destination. Installed Cashier omits it. */
  readonly controlCentreHref?: string | undefined;
  /**
   * Optional host trust gate for reopening a local workspace while the server
   * is unreachable. Browser POS omits it and retains its existing bounded
   * snapshot behavior. Installed Cashier supplies an OS/native verifier that
   * checks the signed device-bound offline authority before this component may
   * render a till from local state.
   */
  readonly authorizeOfflineWorkspace?:
    ((snapshot: OfflineWorkspaceSnapshot) => Promise<boolean>) | undefined;
}

function Waiting({ label }: { readonly label: string }): JSX.Element {
  return (
    <Screen title="نقطة بيع كورفي">
      <CardSurface className="p-6">
        <p className="text-center text-sm text-muted-foreground" role="status" aria-live="polite">
          {label}
        </p>
      </CardSurface>
    </Screen>
  );
}

export function PosApp({
  api,
  onManagementLanding,
  controlCentreHref,
  authorizeOfflineWorkspace,
}: PosAppProps): JSX.Element {
  const session = useSession(api);
  const [offlineWorkspace, setOfflineWorkspace] = useState<OfflineWorkspaceSnapshot | null>(null);
  const [offlineAuthorizationPending, setOfflineAuthorizationPending] = useState(false);

  const authenticated = session.state.kind === 'ready';
  const managementLanding =
    onManagementLanding !== undefined &&
    session.state.kind === 'ready' &&
    prefersMerchantControl(session.state.principal);
  const terminal = useTerminal(api, authenticated && !managementLanding, session.expire);
  const chosenTerminalId = terminal.state.kind === 'chosen' ? terminal.state.terminal.id : null;
  const cashierId = session.state.kind === 'ready' ? session.state.principal.user.id : '';
  const shift = useShift(api, chosenTerminalId, cashierId, session.expire);

  const signOut = useCallback(() => {
    session.signOut();
  }, [session]);

  useEffect(() => {
    if (managementLanding) onManagementLanding?.();
  }, [managementLanding, onManagementLanding]);

  useEffect(() => {
    if (session.state.kind !== 'unavailable') {
      setOfflineAuthorizationPending(false);
      setOfflineWorkspace(null);
      return;
    }

    const snapshot = readOfflineWorkspace();
    if (snapshot === null || authorizeOfflineWorkspace === undefined) {
      setOfflineAuthorizationPending(false);
      setOfflineWorkspace(snapshot);
      return;
    }

    let live = true;
    setOfflineWorkspace(null);
    setOfflineAuthorizationPending(true);
    void authorizeOfflineWorkspace(snapshot)
      .then((allowed) => {
        if (live) setOfflineWorkspace(allowed ? snapshot : null);
      })
      .catch(() => {
        if (live) setOfflineWorkspace(null);
      })
      .finally(() => {
        if (live) setOfflineAuthorizationPending(false);
      });
    return () => {
      live = false;
    };
  }, [authorizeOfflineWorkspace, session.state.kind]);

  useEffect(() => {
    if (
      session.state.kind !== 'ready' ||
      terminal.state.kind !== 'chosen' ||
      shift.state.kind !== 'open' ||
      (typeof navigator !== 'undefined' && !navigator.onLine)
    ) {
      return;
    }
    writeOfflineWorkspace({
      principal: session.state.principal,
      terminal: terminal.state.terminal,
      shift: shift.state.shift,
      priceMode: terminal.state.settings.priceMode,
    });
  }, [session.state, shift.state, terminal.state]);

  useEffect(() => {
    if (session.state.kind !== 'unavailable' || offlineWorkspace === null) return;
    const revalidate = () => session.retry();
    globalThis.addEventListener('online', revalidate);
    return () => globalThis.removeEventListener('online', revalidate);
  }, [offlineWorkspace, session]);

  if (session.state.kind === 'loading') return <Waiting label="جارٍ التحقق من الجلسة…" />;

  if (session.state.kind === 'signing-out') {
    return <Waiting label="جارٍ تسجيل الخروج بأمان…" />;
  }

  if (session.state.kind === 'logout-failed') {
    return (
      <BlockedScreen
        title="لم يتم تأكيد الخروج"
        tone="danger"
        failure={LOGOUT_UNCONFIRMED}
        onRetry={signOut}
        retryLabel="إعادة محاولة تسجيل الخروج"
      />
    );
  }

  if (session.state.kind === 'unavailable') {
    if (offlineAuthorizationPending) {
      return <Waiting label="جارٍ التحقق من صلاحية العمل دون اتصال…" />;
    }
    if (offlineWorkspace !== null) {
      return (
        <CashierScreen
          api={api}
          principal={offlineWorkspace.principal}
          terminal={offlineWorkspace.terminal}
          shift={offlineWorkspace.shift}
          priceMode={offlineWorkspace.priceMode}
          controlCentreHref={controlCentreHref}
          onSignOut={() => undefined}
          onExpired={session.expire}
          onShiftChanged={() => undefined}
        />
      );
    }
    return (
      <Screen title="الخدمة غير متاحة">
        <CardSurface className="flex flex-col gap-4 p-6">
          <StatusNote tone="warning" live>
            {session.state.failure.message}
          </StatusNote>
          <Button size="lg" onClick={session.retry}>
            إعادة المحاولة
          </Button>
        </CardSurface>
      </Screen>
    );
  }

  if (session.state.kind === 'anonymous') {
    return (
      <LoginScreen api={api} onAuthenticated={session.signedIn} notice={session.state.notice} />
    );
  }

  if (managementLanding) return <Waiting label="جارٍ فتح لوحة إدارة المنشأة…" />;

  const principal = session.state.principal;

  if (terminal.state.kind === 'loading') return <Waiting label="جارٍ قراءة صناديق الفرع…" />;
  if (terminal.state.kind === 'blocked') {
    return (
      <BlockedScreen
        title="لا يمكن بدء البيع"
        failure={terminal.state.failure}
        onRetry={terminal.reload}
        onSignOut={signOut}
      />
    );
  }
  if (terminal.state.kind === 'choosing') {
    return (
      <TerminalPicker
        terminals={terminal.state.terminals}
        onChoose={terminal.choose}
        onSignOut={signOut}
      />
    );
  }

  const chosen = terminal.state.terminal;
  const settings = terminal.state.settings;

  if (shift.state.kind === 'loading') return <Waiting label="جارٍ قراءة حالة الوردية…" />;
  if (shift.state.kind === 'blocked') {
    return (
      <BlockedScreen
        title="تعذّر قراءة الوردية"
        failure={shift.state.failure}
        onRetry={shift.refresh}
        onChangeTerminal={terminal.change}
        onSignOut={signOut}
      />
    );
  }
  if (shift.state.kind === 'foreign') {
    return (
      <BlockedScreen
        title="الوردية تخصّ كاشيراً آخر"
        failure={FOREIGN_SHIFT}
        onRetry={shift.refresh}
        onChangeTerminal={terminal.change}
        onSignOut={signOut}
      />
    );
  }
  if (shift.state.kind === 'closed') {
    return (
      <ShiftGate
        terminal={chosen}
        opening={shift.opening}
        onOpen={shift.open}
        onChangeTerminal={terminal.change}
        onSignOut={signOut}
      />
    );
  }

  return (
    <CashierScreen
      api={api}
      principal={principal}
      terminal={chosen}
      shift={shift.state.shift}
      priceMode={settings.priceMode}
      controlCentreHref={controlCentreHref}
      onSignOut={signOut}
      onExpired={session.expire}
      onShiftChanged={shift.refresh}
    />
  );
}
