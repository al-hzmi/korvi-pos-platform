import { ApiError } from './api';
import { describeFailure } from './failures';
import type { ApiClient, RequestOptions } from './api';
import type { Principal } from './api-types';
import type { Failure } from './failures';

/**
 * Who is at the till, resolved from the cookie the browser already holds.
 *
 * There is no token to read and nothing in storage to restore. The only
 * question the app can ask is "does the server still know me", and the only
 * way to ask it is GET /v1/auth/me. A 401 is a clean answer, not a failure —
 * it means show the login screen. A network problem is a different answer, and
 * conflating the two would log a cashier out because a switch rebooted.
 *
 * `loading` exists so the cashier screen never flashes before the answer
 * arrives. The permissions that come back are used to hide affordances and for
 * nothing else; every route re-checks them server-side.
 */

export type SessionState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'anonymous'; readonly notice: Failure | null }
  | { readonly kind: 'unavailable'; readonly failure: Failure }
  | { readonly kind: 'ready'; readonly principal: Principal }
  /** Selling is already blocked; the server has not answered yet. */
  | { readonly kind: 'signing-out'; readonly principal: Principal }
  /** The server never confirmed. The cookie may still be live. */
  | { readonly kind: 'logout-failed'; readonly principal: Principal; readonly failure: Failure };

export const initialSessionState: SessionState = { kind: 'loading' };

export async function loadSession(api: ApiClient, options?: RequestOptions): Promise<SessionState> {
  try {
    return { kind: 'ready', principal: await api.me(options) };
  } catch (error) {
    if (error instanceof ApiError && error.unauthenticated) {
      return { kind: 'anonymous', notice: null };
    }
    return { kind: 'unavailable', failure: describeFailure(error) };
  }
}

export type LogoutResult =
  { readonly confirmed: true } | { readonly confirmed: false; readonly failure: Failure };

/**
 * Ask the server to revoke the session, and report whether it said so.
 *
 * The distinction this function exists to preserve: the session cookie is
 * HttpOnly, so the browser cannot clear it and JavaScript cannot read it. Only
 * the server can end a session. If the request never arrived, the session is
 * still live and the cookie is still in the browser — and a screen that
 * returned to the login form would be telling a cashier they had logged out of
 * a till that will happily restore them on reload. On a shared machine that is
 * the next person's sale under the previous person's name.
 */
export async function requestLogout(api: ApiClient): Promise<LogoutResult> {
  try {
    await api.logout();
    return { confirmed: true };
  } catch (error) {
    return { confirmed: false, failure: describeFailure(error) };
  }
}

export function hasPermission(principal: Principal, permission: string): boolean {
  return principal.permissions.includes(permission);
}

/**
 * What a screen must say when the server never confirmed the logout.
 *
 * Stated once and shared, because there are now two apps that can reach this
 * state and one of them is wrong the moment they disagree. The invariant is
 * not the wording — it is that this state is blocking. The session cookie is
 * HttpOnly: only the server can revoke it, and if the logout request never
 * arrived the session is still live. Rendering the ordinary login form here
 * would tell an operator they had signed out of a machine that will restore
 * them on reload. On a shared till that is the next person's work under the
 * last person's name.
 */
export const LOGOUT_UNCONFIRMED: Failure = {
  code: 'logout_unconfirmed',
  message:
    'لم يؤكّد الخادم إنهاء الجلسة، وقد تكون ما تزال مفتوحة. لا تترك الصندوق قبل نجاح تسجيل الخروج.',
  action: 'blocking',
};
