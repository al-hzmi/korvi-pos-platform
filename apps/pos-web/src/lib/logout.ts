import { requestLogout } from './session';
import { forgetTerminalId } from './device-memory';
import { clearOfflineWorkspace } from './offline-workspace';
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
      emit({ kind: 'signing-out', principal });

      void requestLogout(api as ApiClient).then((result) => {
        inFlight = false;
        if (result.confirmed) {
          // Only a confirmed server logout may erase the local offline lease.
          // An unconfirmed logout could leave the HttpOnly session live, so
          // deleting local identity then would create a false sense of safety.
          forget();
          clearOfflineWorkspace();
          emit({ kind: 'anonymous', notice: null });
          return;
        }
        emit({ kind: 'logout-failed', principal, failure: result.failure });
      });
    },
  };
}
