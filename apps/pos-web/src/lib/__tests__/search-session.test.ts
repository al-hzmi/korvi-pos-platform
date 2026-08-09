import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { DEBOUNCE_MS, createSearchSession } from '../search-session';
import type { ProductSummary } from '../api-types';
import type { SearchSource, SearchState } from '../search';

/**
 * The property under test is a count.
 *
 * `add` runs once per item scanned — hundreds of times an hour on a busy till,
 * over a shop uplink shared with the card terminal. A single stray request in
 * that path is a regression nobody notices until a queue forms, so it is
 * asserted numerically rather than described.
 */

const MILK: ProductSummary = {
  id: 'p-milk',
  sku: 'MILK-1L',
  nameAr: 'حليب طازج',
  nameEn: null,
  productType: 'unit',
  unitLabel: null,
  priceMinor: '1150',
  vatBasisPoints: 1500,
  primaryBarcode: '6281000000001',
  trackInventory: true,
};

interface Harness {
  readonly queries: Array<{ readonly q?: string; readonly limit?: number }>;
  readonly states: SearchState[];
  readonly terms: string[];
  readonly source: SearchSource;
}

function harness(results: readonly ProductSummary[] = [MILK]): Harness {
  const queries: Array<{ readonly q?: string; readonly limit?: number }> = [];
  return {
    queries,
    states: [],
    terms: [],
    source: {
      products: (query) => {
        queries.push(query);
        return Promise.resolve(results);
      },
    },
  };
}

function sessionFor(h: Harness) {
  return createSearchSession(h.source, {
    state: (state) => h.states.push(state),
    term: (term) => h.terms.push(term),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('what each gesture costs', () => {
  it('opens the till with exactly one catalogue request, and no term', async () => {
    const h = harness();
    sessionFor(h).browse();
    await vi.runAllTimersAsync();

    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]).not.toHaveProperty('q');
    expect(h.states.at(-1)).toMatchObject({ status: 'ready', results: [MILK] });
  });

  it('still debounces typing into one request', async () => {
    const h = harness();
    const session = sessionFor(h);

    session.setTerm('ح');
    session.setTerm('حل');
    session.setTerm('حليب');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);

    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]).toMatchObject({ q: 'حليب' });
    expect(h.terms).toEqual(['ح', 'حل', 'حليب']);
  });

  it('clearing a typed term goes back to the catalogue, after the debounce', async () => {
    const h = harness();
    const session = sessionFor(h);

    session.setTerm('حليب');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    session.setTerm('');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);

    expect(h.queries).toHaveLength(2);
    expect(h.queries[1]).not.toHaveProperty('q');
  });

  it('costs NOTHING to clear the box after a scan', async () => {
    const h = harness();
    const session = sessionFor(h);

    session.browse();
    await vi.runAllTimersAsync();
    expect(h.queries).toHaveLength(1);

    // Twenty items through the till.
    for (let i = 0; i < 20; i += 1) {
      session.reset();
      await vi.runAllTimersAsync();
    }

    expect(h.queries).toHaveLength(1);
  });

  it('puts the catalogue back from memory when the box is cleared', async () => {
    const h = harness();
    const session = sessionFor(h);

    session.browse();
    await vi.runAllTimersAsync();
    session.runNow('حليب');
    await vi.runAllTimersAsync();

    session.reset();

    expect(h.queries).toHaveLength(2);
    expect(h.states.at(-1)).toMatchObject({ term: '', status: 'ready', results: [MILK] });
    expect(h.terms.at(-1)).toBe('');
  });

  it('clears to an empty panel when there is no catalogue to put back', () => {
    const h = harness();
    sessionFor(h).reset();

    expect(h.queries).toHaveLength(0);
    expect(h.states.at(-1)).toMatchObject({ status: 'idle', results: [] });
  });

  it('drops a pending keystroke rather than letting it land on the next item', async () => {
    const h = harness();
    const session = sessionFor(h);

    session.setTerm('حلي');
    session.reset();
    await vi.runAllTimersAsync();

    expect(h.queries).toHaveLength(0);
  });

  it('does not remember a failed browse as the catalogue', async () => {
    const queries: Array<{ readonly q?: string }> = [];
    const states: SearchState[] = [];
    const session = createSearchSession(
      {
        products: (query) => {
          queries.push(query);
          return Promise.reject(new ApiError(0, 'network', null));
        },
      },
      { state: (state) => states.push(state), term: () => undefined },
    );

    session.browse();
    await vi.runAllTimersAsync();
    session.reset();

    expect(queries).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({ status: 'idle', results: [] });
  });

  it('a new sale refreshes the catalogue at most once', async () => {
    const h = harness();
    const session = sessionFor(h);

    session.browse();
    await vi.runAllTimersAsync();
    session.browse();
    await vi.runAllTimersAsync();

    expect(h.queries).toHaveLength(2);
  });

  it('retires an in-flight query on dispose', async () => {
    const h = harness();
    const session = sessionFor(h);

    session.setTerm('حليب');
    session.dispose();
    await vi.runAllTimersAsync();

    expect(h.queries).toHaveLength(0);
  });
});
