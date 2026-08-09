'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { initialSearchState } from '../lib/search';
import { createSearchSession } from '../lib/search-session';
import type { ApiClient } from '../lib/api';
import type { SearchState } from '../lib/search';

/**
 * React's share of the search box: two pieces of state and a cleanup.
 *
 * The policy — what is debounced, what goes to the server, and what is merely
 * cleared — lives in lib/search-session.ts, where it can be tested for the
 * number of requests each gesture costs without a browser in the way.
 */
export interface SearchHandle {
  readonly term: string;
  readonly state: SearchState;
  readonly setTerm: (term: string) => void;
  readonly runNow: (term: string) => void;
  /** Clear the box. Local only — issues no request. */
  readonly reset: () => void;
  /** Load the catalogue. One request. */
  readonly browse: () => void;
}

export function useProductSearch(api: ApiClient): SearchHandle {
  const [term, setTermState] = useState('');
  const [state, setState] = useState<SearchState>(initialSearchState);

  const session = useMemo(
    () => createSearchSession(api, { state: setState, term: setTermState }),
    [api],
  );

  useEffect(() => {
    return () => {
      session.dispose();
    };
  }, [session]);

  const setTerm = useCallback(
    (next: string) => {
      session.setTerm(next);
    },
    [session],
  );

  const runNow = useCallback(
    (next: string) => {
      session.runNow(next);
    },
    [session],
  );

  const reset = useCallback(() => {
    session.reset();
  }, [session]);

  const browse = useCallback(() => {
    session.browse();
  }, [session]);

  return { term, state, setTerm, runNow, reset, browse };
}
