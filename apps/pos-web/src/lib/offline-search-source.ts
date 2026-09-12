import { ApiError } from './api';
import { openKorviOfflineStore } from './offline-store';
import type { SearchSource } from './search';

/**
 * Product reads with a durable, tenant-partitioned browser fallback.
 *
 * A successful server answer is persisted before it is published to the
 * cashier, so anything the operator has actually seen can survive a link
 * outage. The cache is never consulted for an HTTP refusal: 401/403/409 are
 * server authority and stale local data must not turn one into permission.
 * Only a request that got no HTTP answer at all may fall back to IndexedDB.
 *
 * Gate 42 provides the durable catalogue substrate. It does not claim that the
 * whole merchant catalogue is synchronized yet; that belongs to the sync and
 * reconciliation gates. This source therefore never invents completeness.
 */
export function createDurableProductSource(source: SearchSource, tenantId: string): SearchSource {
  return {
    async products(query, options) {
      try {
        const products = await source.products(query, options);
        try {
          const store = await openKorviOfflineStore();
          try {
            await store.upsertCatalogue(tenantId, products);
          } finally {
            store.close();
          }
        } catch {
          // Online catalogue authority remains usable if local durability is
          // unavailable. The sale-draft path surfaces the device durability
          // warning in the cashier UI; this read must not turn a local quota
          // problem into a false "product not found" result.
        }
        return products;
      } catch (error) {
        if (!(error instanceof ApiError) || !error.ambiguous) throw error;
        try {
          const store = await openKorviOfflineStore();
          try {
            return await store.searchCatalogue(tenantId, query.q ?? '', query.limit ?? 20);
          } finally {
            store.close();
          }
        } catch {
          // Preserve the network failure rather than laundering a broken or
          // unavailable local store into an empty product result.
          throw error;
        }
      }
    },
  };
}
