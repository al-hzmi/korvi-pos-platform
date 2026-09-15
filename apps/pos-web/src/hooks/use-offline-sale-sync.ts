'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { QueuePartition } from '@korvi/domain';
import type { ApiClient } from '../lib/api';
import { syncOfflineCheckouts, type OfflineSaleReviewCase } from '../lib/offline-checkout';

export interface OfflineSaleSyncState {
  readonly status: 'idle' | 'syncing' | 'ready' | 'failed';
  readonly pendingCount: number;
  readonly needsReview: readonly OfflineSaleReviewCase[];
}

const INITIAL: OfflineSaleSyncState = { status: 'idle', pendingCount: 0, needsReview: [] };

export function useOfflineSaleSync(
  api: ApiClient,
  partition: QueuePartition,
  onUnauthenticated: () => void,
): { readonly state: OfflineSaleSyncState; readonly retry: () => void } {
  const [state, setState] = useState<OfflineSaleSyncState>(INITIAL);
  const running = useRef(false);
  const mounted = useRef(true);

  const run = useCallback(() => {
    if (running.current) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    running.current = true;
    setState((current) => ({ ...current, status: 'syncing' }));
    void syncOfflineCheckouts(api, partition, onUnauthenticated)
      .then((snapshot) => {
        if (!mounted.current) return;
        setState({
          status: 'ready',
          pendingCount: snapshot.pendingCount,
          needsReview: snapshot.needsReview,
        });
      })
      .catch(() => {
        if (!mounted.current) return;
        setState((current) => ({ ...current, status: 'failed' }));
      })
      .finally(() => {
        running.current = false;
      });
  }, [api, onUnauthenticated, partition]);

  useEffect(() => {
    mounted.current = true;
    run();
    const online = () => run();
    globalThis.addEventListener('online', online);
    const timer = globalThis.setInterval(run, 60_000);
    return () => {
      mounted.current = false;
      globalThis.removeEventListener('online', online);
      globalThis.clearInterval(timer);
    };
  }, [run]);

  return { state, retry: run };
}
