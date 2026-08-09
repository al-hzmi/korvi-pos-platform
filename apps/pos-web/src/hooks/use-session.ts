'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSession } from '../lib/session';
import { createLogoutController } from '../lib/logout';
import type { ApiClient } from '../lib/api';
import type { Principal } from '../lib/api-types';
import type { LogoutController } from '../lib/logout';
import type { SessionState } from '../lib/session';

/**
 * The boot question, asked once and answerable again.
 *
 * `expire` is what every other hook calls when it meets a 401: the session is
 * gone, the screen goes back to login, and nothing pretends otherwise.
 *
 * `signOut` is the opposite case and is handled by a controller held across
 * renders, for the same reason the checkout flight is: two clicks in one tick
 * both read the old state, and only a synchronous guard stops the second from
 * issuing a request.
 */
export interface SessionHandle {
  readonly state: SessionState;
  readonly signedIn: (principal: Principal) => void;
  readonly expire: () => void;
  readonly signOut: () => void;
  readonly retry: () => void;
}

export function useSession(api: ApiClient): SessionHandle {
  const [state, setState] = useState<SessionState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const logout = useRef<LogoutController | null>(null);
  logout.current ??= createLogoutController(api);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    void loadSession(api, { signal: controller.signal }).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
      controller.abort();
    };
  }, [api, attempt]);

  const signedIn = useCallback((principal: Principal) => {
    setState({ kind: 'ready', principal });
  }, []);

  const expire = useCallback(() => {
    setState({
      kind: 'anonymous',
      notice: {
        code: 'unauthenticated',
        message: 'انتهت الجلسة. سجّل الدخول من جديد.',
        action: 'reauthenticate',
      },
    });
  }, []);

  const signOut = useCallback(() => {
    const principal =
      state.kind === 'ready' || state.kind === 'signing-out' || state.kind === 'logout-failed'
        ? state.principal
        : null;
    if (principal === null) return;
    logout.current?.signOut(principal, setState);
  }, [state]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  return { state, signedIn, expire, signOut, retry };
}
