'use client';

import { useCallback, useEffect, useState } from 'react';
import { loadTerminals } from '../lib/terminal';
import { forgetTerminalId, rememberTerminalId, rememberedTerminalId } from '../lib/device-memory';
import type { ApiClient } from '../lib/api';
import type { TerminalSummary } from '../lib/api-types';
import type { TerminalState } from '../lib/terminal';

export interface TerminalHandle {
  readonly state: TerminalState;
  readonly choose: (terminal: TerminalSummary) => void;
  /** Re-read the list, keeping whichever till this browser remembers. */
  readonly reload: () => void;
  /** Forget this till and ask again — the only way to reach the selector. */
  readonly change: () => void;
}

export function useTerminal(
  api: ApiClient,
  enabled: boolean,
  onUnauthenticated: () => void,
): TerminalHandle {
  const [state, setState] = useState<TerminalState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // Set by `change`, cleared as soon as the reload has consumed it. Without
  // it, "change terminal" re-reads the remembered id and lands straight back
  // on the same till.
  const [ignoreRemembered, setIgnoreRemembered] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let live = true;

    void loadTerminals(api, ignoreRemembered ? null : rememberedTerminalId(), {
      signal: controller.signal,
    }).then((next) => {
      if (!live) return;
      if (next.kind === 'blocked' && next.failure.action === 'reauthenticate') {
        onUnauthenticated();
        return;
      }
      if (next.kind === 'chosen') rememberTerminalId(next.terminal.id);
      setIgnoreRemembered(false);
      setState(next);
    });

    return () => {
      live = false;
      controller.abort();
    };
  }, [api, enabled, attempt, ignoreRemembered, onUnauthenticated]);

  const choose = useCallback((terminal: TerminalSummary) => {
    rememberTerminalId(terminal.id);
    setState((current) =>
      current.kind === 'choosing' || current.kind === 'chosen'
        ? { kind: 'chosen', terminal, settings: current.settings }
        : current,
    );
  }, []);

  const reload = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  const change = useCallback(() => {
    // Device context only. Nothing about the session is touched.
    forgetTerminalId();
    setIgnoreRemembered(true);
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  return { state, choose, reload, change };
}
