'use client';

import { useCallback, useEffect, useState } from 'react';
import { loadShift } from '../lib/shift';
import { describeFailure } from '../lib/failures';
import type { ApiClient } from '../lib/api';
import type { ShiftState } from '../lib/shift';
import type { Failure } from '../lib/failures';

export interface ShiftHandle {
  readonly state: ShiftState;
  readonly opening: boolean;
  readonly openFailure: Failure | null;
  readonly open: (openingFloatMinor: string) => void;
  readonly refresh: () => void;
}

export function useShift(
  api: ApiClient,
  terminalId: string | null,
  userId: string,
  onUnauthenticated: () => void,
): ShiftHandle {
  const [state, setState] = useState<ShiftState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [opening, setOpening] = useState(false);
  const [openFailure, setOpenFailure] = useState<Failure | null>(null);

  useEffect(() => {
    if (terminalId === null) return;
    const controller = new AbortController();
    let live = true;

    void loadShift(api, terminalId, userId, { signal: controller.signal }).then((next) => {
      if (!live) return;
      if (next.kind === 'blocked' && next.failure.action === 'reauthenticate') {
        onUnauthenticated();
        return;
      }
      setState(next);
    });

    return () => {
      live = false;
      controller.abort();
    };
  }, [api, terminalId, userId, attempt, onUnauthenticated]);

  const refresh = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  const open = useCallback(
    (openingFloatMinor: string) => {
      if (terminalId === null || opening) return;
      setOpening(true);
      setOpenFailure(null);

      void api
        .openShift({ terminalId, openingFloatMinor })
        .then((shift) => {
          // Even a shift this cashier just opened is checked, because the
          // server is the one that decided whose it is.
          setState(shift.userId === userId ? { kind: 'open', shift } : { kind: 'foreign', shift });
        })
        .catch((error: unknown) => {
          const failure = describeFailure(error);
          if (failure.action === 'reauthenticate') {
            onUnauthenticated();
            return;
          }
          // Somebody else opened it on this till a moment ago: re-read rather
          // than argue with the server about it.
          if (failure.action === 'refresh-shift') setAttempt((value) => value + 1);
          setOpenFailure(failure);
        })
        .finally(() => {
          setOpening(false);
        });
    },
    [api, terminalId, userId, opening, onUnauthenticated],
  );

  return { state, opening, openFailure, open, refresh };
}
