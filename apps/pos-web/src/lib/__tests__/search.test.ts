import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { autoAddCandidate, createProductSearch, initialSearchState } from '../search';
import type { ProductSummary } from '../api-types';
import type { SearchSource, SearchState } from '../search';

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

const RICE: ProductSummary = { ...MILK, id: 'p-rice', sku: 'RICE-5K', nameAr: 'أرز' };

interface Deferred {
  readonly promise: Promise<readonly ProductSummary[]>;
  resolve(results: readonly ProductSummary[]): void;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let resolve!: (results: readonly ProductSummary[]) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<readonly ProductSummary[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('product search', () => {
  it('never lets a slow earlier query overwrite a newer one', async () => {
    // The failure this prevents: the cashier finishes typing "حليب", the
    // answer for "ح" lands afterwards, and the grid shows the wrong products.
    const slow = deferred();
    const fast = deferred();
    const queries: string[] = [];
    const source: SearchSource = {
      products: (query) => {
        queries.push(query.q ?? '');
        return queries.length === 1 ? slow.promise : fast.promise;
      },
    };

    const states: SearchState[] = [];
    const search = createProductSearch(source, (state) => states.push(state));

    const first = search.run('ح');
    const second = search.run('حليب');
    fast.resolve([RICE]);
    await second;
    slow.resolve([MILK]);
    await first;

    const published = states.filter((state) => state.status === 'ready');
    expect(published).toHaveLength(1);
    expect(published[0]?.term).toBe('حليب');
    expect(published[0]?.results).toEqual([RICE]);
  });

  it('aborts the request it is replacing', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const pending = deferred();
    const source: SearchSource = {
      products: (_query, options) => {
        signals.push(options?.signal);
        return pending.promise;
      },
    };
    const search = createProductSearch(source, () => undefined);

    void search.run('ح');
    void search.run('حل');

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    pending.resolve([]);
  });

  it('treats an abort as a cancellation, not as a failure', async () => {
    // The deliberate asymmetry with checkout: nothing happened here and
    // nothing is owed, so there is no state to preserve and nothing to retry.
    const source: SearchSource = {
      products: () => Promise.reject(new DOMException('aborted', 'AbortError')),
    };
    const states: SearchState[] = [];
    const search = createProductSearch(source, (state) => states.push(state));

    await search.run('حليب');
    expect(states.some((state) => state.status === 'failed')).toBe(false);
  });

  it('browses the catalogue for an empty term instead of asking nothing', async () => {
    // Changed deliberately in Strike 3B-2A. An empty till used to be an empty
    // grid, which is a worse first screen than the shelf the shop actually
    // has. Browsing is the same request without a `q`, so it inherits the
    // sequence guard and the abort handling rather than adding a second path.
    const queries: Array<{ readonly q?: string; readonly limit?: number }> = [];
    const source: SearchSource = {
      products: (query) => {
        queries.push(query);
        return Promise.resolve([MILK] as readonly ProductSummary[]);
      },
    };
    const states: SearchState[] = [];
    const search = createProductSearch(source, (state) => states.push(state));

    await search.run('   ');

    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toHaveProperty('q');
    expect(states.at(-1)).toMatchObject({ status: 'ready', results: [MILK] });
  });

  it('turns a failure into something the cashier can read', async () => {
    const source: SearchSource = {
      products: () => Promise.reject(new ApiError(0, 'network', null)),
    };
    const states: SearchState[] = [];
    const search = createProductSearch(source, (state) => states.push(state));

    await search.run('حليب');

    const last = states.at(-1);
    expect(last?.status).toBe('failed');
    expect(last?.failure?.message).toContain('الخادم');
  });

  it('says nothing after cancel', async () => {
    const pending = deferred();
    const states: SearchState[] = [];
    const search = createProductSearch({ products: () => pending.promise }, (state) =>
      states.push(state),
    );

    const run = search.run('حليب');
    search.cancel();
    pending.resolve([MILK]);
    await run;

    expect(states.some((state) => state.status === 'ready')).toBe(false);
  });
});

describe('what a bare Enter may add', () => {
  const ready = (term: string, results: readonly ProductSummary[]): SearchState => ({
    ...initialSearchState,
    term,
    status: 'ready',
    results,
  });

  it('adds the single result of a scanned barcode', () => {
    expect(autoAddCandidate(ready('6281000000001', [MILK]))).toEqual(MILK);
  });

  it('adds the single result of an exact code', () => {
    expect(autoAddCandidate(ready('MILK-1L', [MILK]))).toEqual(MILK);
  });

  it('will not guess from a word, even when only one thing matches today', () => {
    // "حليب" matching one product now may match three next week, and silently
    // adding one of them is not a habit worth training into a cashier.
    expect(autoAddCandidate(ready('حليب', [MILK]))).toBeNull();
  });

  it('will not guess when several things matched', () => {
    expect(autoAddCandidate(ready('6281000000001', [MILK, RICE]))).toBeNull();
  });
});
