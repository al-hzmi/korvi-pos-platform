import { LOGOUT_UNCONFIRMED } from './session';
import type { Principal } from './api-types';
import type { Failure } from './failures';
import type { SessionState } from './session';

/**
 * Which screen the control centre is on, decided without React.
 *
 * The mapping is here rather than inside the component for one reason: the
 * `logout-failed` case is a security property, and a security property that
 * can only be checked by driving a browser is a security property that stops
 * being checked. As a pure function it is asserted directly, alongside the
 * render that consumes it.
 *
 * It is deliberately the same decision the till makes in PosApp — an operator
 * who cannot confirm they are signed out of one app must not be told they are
 * signed out by the other.
 */
export type ControlView =
  | { readonly kind: 'waiting'; readonly label: string }
  | { readonly kind: 'logout-unconfirmed'; readonly failure: Failure }
  | { readonly kind: 'unavailable'; readonly failure: Failure }
  | { readonly kind: 'login'; readonly notice: Failure | null }
  | { readonly kind: 'ready'; readonly principal: Principal };

export function controlView(state: SessionState): ControlView {
  if (state.kind === 'loading') return { kind: 'waiting', label: 'جارٍ التحقق من الجلسة…' };

  // Already blocked, before the server has answered.
  if (state.kind === 'signing-out') return { kind: 'waiting', label: 'جارٍ تسجيل الخروج بأمان…' };

  /*
   * Never the login screen, and never the dashboard either.
   *
   * The server did not confirm the revocation, so the session may still be
   * live. Showing the login form would be a false all-clear; showing the
   * control centre would carry on serving tenant data through a session the
   * operator has already tried to end. The only honest screen is a blocking
   * one that offers to try the logout again.
   */
  if (state.kind === 'logout-failed') {
    return { kind: 'logout-unconfirmed', failure: LOGOUT_UNCONFIRMED };
  }

  if (state.kind === 'unavailable') return { kind: 'unavailable', failure: state.failure };
  if (state.kind === 'anonymous') return { kind: 'login', notice: state.notice };
  return { kind: 'ready', principal: state.principal };
}
