import { requestLogout } from './session';
import { forgetTerminalId } from './device-memory';
import type { ApiClient } from './api';
import type { Principal } from './api-types';
import type { SessionState } from './session';

/**
 * Signing out, treated as a transaction rather than a screen change.
 *
 * Two things make this more than `setState('anonymous')`. The session cookie is
 * HttpOnly, so only the server can end a session and this code cannot verify
 * one has ended except by being told; and a till is a shared machine, so a
 * cashier who is told they have logged out and has not is the next person's
 * problem.
 *
 * So the sequence is: stop selling, ask, and only change identity on a
 * confirmed answer. An unconfirmed logout is its own state, not a return to
 * the login form.
 */
export interface LogoutController {
  /** Ignored if one is already running: at most one request per logout. */
  signOut(principal: Principal, emit: (state: SessionState) => void): void;
  running(): boolean;
}

export function createLogoutController(
  api: Pick<ApiClient, 'logout'>,
  forget: () => void = forgetTerminalId,
): LogoutController {
  let inFlight = false;

  return {
    running: () => inFlight,

    signOut(principal, emit) {
      if (inFlight) return;
      inFlight = true;
      // Selling stops before the request goes out, not after it comes back.
      emit({ kind: 'signing-out', principal });

      void requestLogout(api as ApiClient).then((result) => {
        inFlight = false;
        if (result.confirmed) {
          // Only now. The server has revoked the session and cleared the
          // cookie, so forgetting the till is both safe and true.
          forget();
          emit({ kind: 'anonymous', notice: null });
          return;
        }
        // The terminal id is deliberately left alone: nothing was secured, and
        // clearing it would make the failure look like a clean exit.
        emit({ kind: 'logout-failed', principal, failure: result.failure });
      });
    },
  };
}
