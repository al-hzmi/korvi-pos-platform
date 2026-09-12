'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  classifyIndexedDbError,
  offlineSaleScopeKey,
  openKorviOfflineStore,
} from '../lib/offline-store';
import type {
  KorviOfflineStore,
  OfflineSaleDraft,
  OfflineSaleScope,
  OfflineStoreErrorCode,
} from '../lib/offline-store';

export type DurableDraftState =
  | { readonly status: 'loading'; readonly draft: null; readonly errorCode: null }
  | { readonly status: 'ready'; readonly draft: OfflineSaleDraft | null; readonly errorCode: null }
  | { readonly status: 'failed'; readonly draft: null; readonly errorCode: OfflineStoreErrorCode };

export interface DurableDraftHandle {
  readonly state: DurableDraftState;
  readonly persist: (draft: OfflineSaleDraft) => void;
  readonly clear: () => void;
}

interface OwnedStore {
  readonly key: string;
  readonly store: KorviOfflineStore;
}

export function useDurableSaleDraft(scope: OfflineSaleScope): DurableDraftHandle {
  const stableScope = useMemo<OfflineSaleScope>(
    () => ({
      tenantId: scope.tenantId,
      branchId: scope.branchId,
      terminalId: scope.terminalId,
      userId: scope.userId,
      shiftId: scope.shiftId,
    }),
    [scope.branchId, scope.shiftId, scope.tenantId, scope.terminalId, scope.userId],
  );
  const key = useMemo(() => offlineSaleScopeKey(stableScope), [stableScope]);
  const owned = useRef<OwnedStore | null>(null);
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  const [state, setState] = useState<DurableDraftState>({
    status: 'loading',
    draft: null,
    errorCode: null,
  });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading', draft: null, errorCode: null });

    void openKorviOfflineStore()
      .then(async (store) => {
        try {
          const draft = await store.loadSaleDraft(stableScope);
          if (!live) {
            store.close();
            return;
          }
          owned.current = { key, store };
          setState({ status: 'ready', draft, errorCode: null });
        } catch (error) {
          store.close();
          throw error;
        }
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({
          status: 'failed',
          draft: null,
          errorCode: classifyIndexedDbError(error).code,
        });
      });

    return () => {
      live = false;
      const current = owned.current;
      if (current?.key !== key) return;
      owned.current = null;
      void writeChain.current.finally(() => current.store.close());
    };
  }, [key, stableScope]);

  const recordFailure = useCallback((error: unknown) => {
    setState({
      status: 'failed',
      draft: null,
      errorCode: classifyIndexedDbError(error).code,
    });
  }, []);

  const persist = useCallback(
    (draft: OfflineSaleDraft) => {
      const current = owned.current;
      if (current === null || current.key !== key) return;
      writeChain.current = writeChain.current
        .catch(() => undefined)
        .then(() => current.store.saveSaleDraft(stableScope, draft))
        .catch((error: unknown) => recordFailure(error));
    },
    [key, recordFailure, stableScope],
  );

  const clear = useCallback(() => {
    const current = owned.current;
    if (current === null || current.key !== key) return;
    writeChain.current = writeChain.current
      .catch(() => undefined)
      .then(() => current.store.deleteSaleDraft(stableScope))
      .catch((error: unknown) => recordFailure(error));
  }, [key, recordFailure, stableScope]);

  return { state, persist, clear };
}
