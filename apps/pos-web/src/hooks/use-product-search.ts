'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createProductSearch, initialSearchState } from '../lib/search';
import type { ApiClient } from '../lib/api';
import type { SearchState } from '../lib/search';

/**
 * A small debounce, and the reason it is small.
 *
 * A person typing a product name generates a request every few keystrokes; a
 * scanner delivers a whole barcode in one burst and then an Enter. 140ms is
 * long enough to collapse the first and short enough that the second is not
 * waiting on a timer while the cashier reaches for the next item.
 */
const DEBOUNCE_MS = 140;

export interface SearchHandle {
  readonly term: string;
  readonly state: SearchState;
  readonly setTerm: (term: string) => void;
  readonly runNow: (term: string) => void;
  readonly reset: () => void;
}

export function useProductSearch(api: ApiClient): SearchHandle {
  const [term, setTermState] = useState('');
  const [state, setState] = useState<SearchState>(initialSearchState);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useMemo(() => createProductSearch(api, setState), [api]);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearTimer();
      search.cancel();
    };
  }, [clearTimer, search]);

  const setTerm = useCallback(
    (next: string) => {
      setTermState(next);
      clearTimer();
      timer.current = setTimeout(() => {
        void search.run(next);
      }, DEBOUNCE_MS);
    },
    [clearTimer, search],
  );

  const runNow = useCallback(
    (next: string) => {
      setTermState(next);
      clearTimer();
      void search.run(next);
    },
    [clearTimer, search],
  );

  const reset = useCallback(() => {
    clearTimer();
    search.cancel();
    setTermState('');
    setState(initialSearchState);
  }, [clearTimer, search]);

  return { term, state, setTerm, runNow, reset };
}
