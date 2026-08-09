import { describeFailure } from './failures';
import type { ProductSummary } from './api-types';
import type { Failure } from './failures';

/**
 * Product search for a till.
 *
 * Two failure modes matter, and neither is about speed. A slow response for
 * "ح" must not land after the response for "حليب" and replace it — the cashier
 * would be looking at results for something they finished typing two seconds
 * ago. And an abandoned request must actually be abandoned, or every keystroke
 * leaves a connection open.
 *
 * So: one AbortController per query, aborted when the next one starts, and a
 * sequence number checked before anything is published. The abort alone is not
 * enough — a response can already be in flight when abort is called.
 *
 * Note the deliberate asymmetry with checkout. An abort here is a
 * cancellation: nothing happened and nothing is owed. An abort of a checkout
 * is an ambiguous transaction, and the two must never share a code path.
 */

export type SearchStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface SearchState {
  readonly term: string;
  readonly status: SearchStatus;
  readonly results: readonly ProductSummary[];
  readonly failure: Failure | null;
}

export const initialSearchState: SearchState = {
  term: '',
  status: 'idle',
  results: [],
  failure: null,
};

export interface SearchSource {
  products(
    query: { readonly q?: string; readonly limit?: number },
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly ProductSummary[]>;
}

export interface ProductSearch {
  /** Run a query, cancelling whatever was in flight. */
  run(term: string): Promise<void>;
  /** Abandon the current query without publishing anything. */
  cancel(): void;
}

export interface SearchOptions {
  readonly limit?: number;
}

export function createProductSearch(
  source: SearchSource,
  emit: (state: SearchState) => void,
  options: SearchOptions = {},
): ProductSearch {
  const limit = options.limit ?? 20;
  let sequence = 0;
  let inFlight: AbortController | null = null;

  const abandon = (): void => {
    inFlight?.abort();
    inFlight = null;
  };

  return {
    cancel(): void {
      // Bumping the sequence retires any response already on the wire.
      sequence += 1;
      abandon();
    },

    async run(term: string): Promise<void> {
      abandon();
      sequence += 1;
      const mine = sequence;

      const trimmed = term.trim();
      if (trimmed === '') {
        emit({ term, status: 'idle', results: [], failure: null });
        return;
      }

      emit({ term, status: 'loading', results: [], failure: null });

      const controller = new AbortController();
      inFlight = controller;

      try {
        const results = await source.products({ q: trimmed, limit }, { signal: controller.signal });
        // The guard that actually prevents the stale overwrite.
        if (mine !== sequence) return;
        emit({ term, status: 'ready', results, failure: null });
      } catch (error) {
        if (mine !== sequence) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        emit({ term, status: 'failed', results: [], failure: describeFailure(error) });
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    },
  };
}

/**
 * The one result a bare Enter may add without the cashier looking.
 *
 * Only when there is exactly one, and only when the term was a code rather
 * than a word: a scanner produces a code and the cashier is already reaching
 * for the next item, while "حليب" matching one product today may match three
 * tomorrow, and silently adding one of them is not a habit worth training.
 */
export function autoAddCandidate(state: SearchState): ProductSummary | null {
  if (state.status !== 'ready' || state.results.length !== 1) return null;
  const term = state.term.trim();
  const looksScanned = /^[0-9]{6,14}$/.test(term);
  const exact =
    state.results[0]?.sku.toLowerCase() === term.toLowerCase() ||
    state.results[0]?.primaryBarcode === term;
  return looksScanned || exact ? (state.results[0] ?? null) : null;
}
