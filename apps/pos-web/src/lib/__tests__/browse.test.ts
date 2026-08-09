import { describe, expect, it, vi } from 'vitest';
import { createProductSearch, initialSearchState } from '../search';
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

describe('the opening grid', () => {
  it('lists the catalogue when nothing has been typed', async () => {
    // A till that shows nothing until somebody types looks broken.
    const queries: unknown[] = [];
    const source: SearchSource = {
      products: (query) => {
        queries.push(query);
        return Promise.resolve([MILK, RICE]);
      },
    };
    const states: SearchState[] = [];
    const search = createProductSearch(source, (state) => states.push(state));

    await search.run('');

    expect(queries).toEqual([{ limit: 20 }]);
    expect(states.at(-1)).toMatchObject({ status: 'ready', results: [MILK, RICE], term: '' });
  });

  it('sends a term once there is one', async () => {
    const queries: { q?: string; limit?: number }[] = [];
    const search = createProductSearch(
      {
        products: (query) => {
          queries.push(query);
          return Promise.resolve([MILK]);
        },
      },
      () => undefined,
    );

    await search.run('حليب');
    expect(queries).toEqual([{ q: 'حليب', limit: 20 }]);
  });

  it('goes back to the catalogue when the box is cleared', async () => {
    const queries: { q?: string }[] = [];
    const states: SearchState[] = [];
    const search = createProductSearch(
      {
        products: (query) => {
          queries.push(query);
          return Promise.resolve(query.q === undefined ? [MILK, RICE] : [MILK]);
        },
      },
      (state) => states.push(state),
    );

    await search.run('حليب');
    await search.run('');

    expect(queries.map((query) => query.q)).toEqual(['حليب', undefined]);
    expect(states.at(-1)?.results).toEqual([MILK, RICE]);
  });

  it('still cannot be overtaken by a slower earlier query', async () => {
    // The browse shares the sequence guard rather than getting an unguarded
    // path of its own.
    let resolveSlow: ((value: readonly ProductSummary[]) => void) | undefined;
    const slow = new Promise<readonly ProductSummary[]>((resolve) => {
      resolveSlow = resolve;
    });
    let call = 0;
    const states: SearchState[] = [];
    const search = createProductSearch(
      {
        products: () => {
          call += 1;
          return call === 1 ? slow : Promise.resolve([RICE]);
        },
      },
      (state) => states.push(state),
    );

    const browse = search.run('');
    const typed = search.run('أرز');
    await typed;
    resolveSlow?.([MILK]);
    await browse;

    const published = states.filter((state) => state.status === 'ready');
    expect(published).toHaveLength(1);
    expect(published[0]?.results).toEqual([RICE]);
  });

  it('aborts the browse it is replacing', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const pending = new Promise<readonly ProductSummary[]>(() => undefined);
    const search = createProductSearch(
      {
        products: (_query, options) => {
          signals.push(options?.signal);
          return pending;
        },
      },
      () => undefined,
    );

    void search.run('');
    void search.run('حليب');
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('reports a failed browse rather than an empty catalogue', async () => {
    // "No products" and "could not ask" must not look the same to a cashier.
    const failing = vi.fn(() => Promise.reject(new Error('boom')));
    const states: SearchState[] = [];
    const search = createProductSearch({ products: failing }, (state) => states.push(state));

    await search.run('');
    expect(states.at(-1)?.status).toBe('failed');
    expect(initialSearchState.status).toBe('idle');
  });
});
