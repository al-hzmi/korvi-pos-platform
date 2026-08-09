import { createProductSearch, initialSearchState } from './search';
import type { ProductSummary } from './api-types';
import type { SearchSource, SearchState } from './search';

/**
 * Everything the till's search box does between keystrokes, with no React in
 * it, so the one property that matters can actually be asserted: how many
 * requests each gesture costs.
 *
 * A cashier scanning a queue's worth of shopping performs `add` more often
 * than any other action in the product. Whatever `add` does happens hundreds
 * of times an hour, on a till sharing a shop's uplink with the card terminal.
 * Clearing the box after a scan must therefore cost nothing on the wire — so
 * the last browse is kept and restored from memory, and only a deliberate
 * gesture (first open, a new sale, clearing a typed term) goes to the server.
 */

/**
 * A small debounce, and the reason it is small.
 *
 * A person typing a product name generates a request every few keystrokes; a
 * scanner delivers a whole barcode in one burst and then an Enter. 140ms is
 * long enough to collapse the first and short enough that the second is not
 * waiting on a timer while the cashier reaches for the next item.
 */
export const DEBOUNCE_MS = 140;

export interface SearchEmitter {
  readonly state: (state: SearchState) => void;
  readonly term: (term: string) => void;
}

export interface SearchSessionOptions {
  readonly limit?: number;
  readonly debounceMs?: number;
}

export interface SearchSession {
  /** Typed into the box: debounced, then a query. */
  setTerm(term: string): void;
  /** Enter, or a scanner's terminating newline: no debounce. */
  runNow(term: string): void;
  /** A deliberate catalogue load. One request. */
  browse(): void;
  /** Clear the box. Local only — never a request. */
  reset(): void;
  dispose(): void;
}

export function createSearchSession(
  source: SearchSource,
  emit: SearchEmitter,
  options: SearchSessionOptions = {},
): SearchSession {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let catalogue: readonly ProductSummary[] | null = null;

  const publish = (state: SearchState): void => {
    // A ready answer to an empty term is the catalogue. Keeping it is what
    // lets `reset` put the grid back without asking the server again.
    if (state.status === 'ready' && state.term.trim() === '') catalogue = state.results;
    emit.state(state);
  };

  const search = createProductSearch(source, publish, options);

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    setTerm(next: string): void {
      emit.term(next);
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void search.run(next);
      }, debounceMs);
    },

    runNow(next: string): void {
      emit.term(next);
      clearTimer();
      void search.run(next);
    },

    browse(): void {
      emit.term('');
      clearTimer();
      void search.run('');
    },

    reset(): void {
      /*
       * Called after every single scan. It must not touch the network.
       *
       * Any pending debounce is dropped and any request in flight is retired,
       * so a query the cashier has already moved past cannot land on the next
       * item's screen. What the grid shows afterwards is the catalogue that
       * was already fetched — from memory, at no cost — or nothing at all if
       * there has not been one yet.
       */
      clearTimer();
      search.cancel();
      emit.term('');
      emit.state(
        catalogue === null
          ? initialSearchState
          : { term: '', status: 'ready', results: catalogue, failure: null },
      );
    },

    dispose(): void {
      clearTimer();
      search.cancel();
    },
  };
}
