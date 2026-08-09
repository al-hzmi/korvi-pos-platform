'use client';

import { useCallback, useMemo } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { LoginScreen } from './login-screen';
import { Screen } from './screen';
import { StatusNote } from './status-note';
import { BlockedScreen, TerminalPicker } from './terminal-picker';
import { ShiftGate } from './shift-gate';
import { CashierScreen } from './cashier-screen';
import { createApiClient } from '../lib/api';
import { FOREIGN_SHIFT } from '../lib/shift';
import { LOGOUT_UNCONFIRMED } from '../lib/session';
import { useSession } from '../hooks/use-session';
import { useTerminal } from '../hooks/use-terminal';
import { useShift } from '../hooks/use-shift';
import type { JSX } from 'react';
import type { ApiClient } from '../lib/api';

/**
 * One decision, made in one place: which screen is the cashier on.
 *
 * Session, then till, then drawer, then selling. Each stage waits for the one
 * before it, and none of them is a security boundary — every request the
 * screens below make is re-checked by the server. What this buys is that a
 * cashier is never shown a till they cannot use or a basket they cannot sell.
 */
export interface PosAppProps {
  /** Injected by tests. Production builds the real client against this origin. */
  readonly api?: ApiClient;
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

export function PosApp({ api: injected }: PosAppProps = {}): JSX.Element {
  const api = useMemo(() => injected ?? createApiClient(), [injected]);
  const session = useSession(api);

  const authenticated = session.state.kind === 'ready';
  const terminal = useTerminal(api, authenticated, session.expire);
  const chosenTerminalId = terminal.state.kind === 'chosen' ? terminal.state.terminal.id : null;
  const cashierId = session.state.kind === 'ready' ? session.state.principal.user.id : '';
  const shift = useShift(api, chosenTerminalId, cashierId, session.expire);

  const signOut = useCallback(() => {
    session.signOut();
  }, [session]);

  if (session.state.kind === 'loading') return <Waiting label="جارٍ التحقق من الجلسة…" />;

  // Selling is already blocked here, before the request has been answered.
  if (session.state.kind === 'signing-out') {
    return <Waiting label="جارٍ تسجيل الخروج بأمان…" />;
  }

  /*
   * The one state that must never quietly become the login screen.
   *
   * The session cookie is HttpOnly: only the server can revoke it, and this
   * code cannot even read it. If the logout request did not arrive, the
   * session is still live — so showing the ordinary login form would tell a
   * cashier they had signed out of a till that will restore them on reload.
   * On a shared machine that is the next person's sale under the last
   * person's name.
   */
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
    // No takeover is offered, because none exists: the sale transaction
    // refuses a shift that is not the cashier's own.
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
        busy={shift.opening}
        failure={shift.openFailure}
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
      onSignOut={signOut}
      onExpired={session.expire}
      onShiftChanged={shift.refresh}
    />
  );
}
